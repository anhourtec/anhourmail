#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs the CI pipeline (.github/workflows/ci.yml) locally against committed code, next to a running dev stack.
#
#   npm run ci:local                                   # every job, against HEAD
#   npm run ci:local -- --jobs integration,e2e         # only some jobs (always run in ci.yml order)
#   npm run ci:local -- --ref origin/main              # another commit
#   npm run ci:local -- --apply .cicd/lib.sh --apply scripts/x.ts
#                                                      # plus the working-tree state of those paths (try a fix
#                                                      # before committing it); nothing else uncommitted is used
#   npm run ci:local -- --patch /path/to/fix.patch     # plus a patch (git apply), e.g. only some hunks of a file
#   npm run ci:local -- --keep                         # keep the clone afterwards (stack and apps still stop)
#   npm run ci:local -- --verbose                      # stream job output instead of only writing the logs
#
# How it stays away from the dev stack and the working tree:
#   - Checks the ref out in a throwaway local clone outside the repository (default
#     ${TMPDIR}/anhourmail-ci-local/run-*). A clone rather than a `git worktree`: the security job runs gitleaks in a
#     container that mounts only the checkout, and a worktree's `.git` file points outside that mount.
#   - Writes the clone's .env from .env.example with every port moved to the 435xx/436xx block (dev uses 43xxx and
#     the standard mail ports; 474xx and 480xx-484xx belong to neighbouring projects) and
#     COMPOSE_PROJECT_NAME=anhourmail-ci, so containers, volumes and ports are separate from the `anhourmail` project.
#   - Runs `.cicd/setup.sh` (npm ci) once, then each job's own `.cicd/<job>.sh`, exactly as ci.yml does. Between jobs
#     the clone is reset (`git clean`, node_modules kept) and the ci stack is removed, as each CI job starts fresh.
#   - Always tears down, also on failure or Ctrl-C: kills the job's process group and anything left listening on the
#     ci app ports, `docker compose down -v` for anhourmail-ci, removes the clone (credentials.md and .env included).
#     Job logs stay in the run directory and are printed by path; they hold no secrets beyond the committed dev
#     placeholders (the demo passwords only ever live in the clone's credentials.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALL_JOBS="checks unit integration rbac e2e build security licences" # ci.yml order
STACK_JOBS=" integration rbac e2e "
PROJECT="anhourmail-ci"

# KEY:port for the ci run. Dev ports this replaces are read from .env.example.
CI_PORTS="SITE_DEV_PORT:43510 WEB_DEV_PORT:43520 WEBMAIL_DEV_PORT:43530 POSTGRES_HOST_PORT:43532
REDIS_HOST_PORT:43579 STALWART_HTTP_PORT:43580 MAILPIT_SMTP_PORT:43525 MAILPIT_UI_PORT:43526
STALWART_SMTP_PORT:43625 STALWART_SUBMISSIONS_PORT:43665 STALWART_SUBMISSION_PORT:43687 STALWART_IMAP_PORT:43643
STALWART_IMAPS_PORT:43693 STALWART_POP3_PORT:43610 STALWART_POP3S_PORT:43695 STALWART_SIEVE_PORT:43690"

usage() { sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'; }

ref="HEAD"
jobs_csv=""
keep=0
verbose=0
apply_paths=()
patches=()
base_dir="${CI_LOCAL_DIR:-${TMPDIR:-/tmp}/anhourmail-ci-local}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref="${2:?--ref needs a value}"; shift 2 ;;
    --jobs) jobs_csv="${2:?--jobs needs a value}"; shift 2 ;;
    --apply) apply_paths+=("${2:?--apply needs a path}"); shift 2 ;;
    --patch) patches+=("$(cd "$(dirname "${2:?--patch needs a file}")" && pwd)/$(basename "$2")"); shift 2 ;;
    --dir) base_dir="${2:?--dir needs a value}"; shift 2 ;;
    --keep) keep=1; shift ;;
    --verbose) verbose=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

selected=""
if [[ -z "$jobs_csv" ]]; then
  selected="$ALL_JOBS"
else
  for j in ${jobs_csv//,/ }; do
    case " $ALL_JOBS " in *" $j "*) ;; *) echo "unknown job: $j (jobs: $ALL_JOBS)" >&2; exit 2 ;; esac
  done
  for j in $ALL_JOBS; do
    case ",$jobs_csv," in *",$j,"*) selected="$selected $j" ;; esac
  done
fi

base_dir="${base_dir%/}"
sha="$(git -C "$ROOT" rev-parse --verify "${ref}^{commit}")"
run_dir="${base_dir}/run-$(date +%Y%m%d-%H%M%S)-$$"
wt="${run_dir}/repo"
logs="${run_dir}/logs"
mkdir -p "$logs"

say() { printf '[ci-local] %s\n' "$*"; }

ci_port() { # KEY -> ci port
  local pair
  for pair in $CI_PORTS; do
    if [[ "${pair%%:*}" == "$1" ]]; then
      echo "${pair#*:}"
      return 0
    fi
  done
  return 1
}

port_listeners() { # pids listening on any ci port
  local pair
  for pair in $CI_PORTS; do lsof -t -nP -iTCP:"${pair#*:}" -sTCP:LISTEN 2>/dev/null || true; done | sort -u
}

job_pid=""
kill_job() {
  if [[ -n "$job_pid" ]]; then
    kill -TERM -- "-${job_pid}" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-${job_pid}" 2>/dev/null || true
    job_pid=""
  fi
  # App servers started by apps_up can outlive their parent. Kill what listens on a ci port only when it runs from
  # the clone; Docker's port forwarder (also listening there) goes away with `compose down`.
  local pid cwd
  for pid in $(port_listeners); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    case "$cwd" in "$wt" | "$wt"/*) kill -TERM "$pid" 2>/dev/null || true ;; esac
  done
}

stack_down() {
  if [[ -f "${wt}/docker-compose.yml" ]]; then
    (cd "$wt" && docker compose -p "$PROJECT" --profile ci --profile dev down -v --remove-orphans >>"${logs}/teardown.log" 2>&1) || true
  else
    docker compose -p "$PROJECT" down -v --remove-orphans >>"${logs}/teardown.log" 2>&1 || true
  fi
}

cleaned=0
# shellcheck disable=SC2317 # reached through the EXIT/INT/TERM traps below
cleanup() {
  [[ $cleaned -eq 1 ]] && return 0
  cleaned=1
  say "teardown: apps, ${PROJECT} stack, clone"
  kill_job
  stack_down
  if [[ $keep -eq 1 ]]; then
    say "kept clone: ${wt} (holds .env and credentials.md: delete it when done)"
  else
    rm -rf "$wt"
  fi
  say "logs: ${logs}"
}
# shellcheck disable=SC2317 # reached through the INT/TERM trap below
on_signal() {
  trap - INT TERM
  echo
  say "interrupted"
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_signal INT TERM

# --- refuse to start on a busy ci port (never touch whatever holds it)
busy=""
for pair in $CI_PORTS; do
  if lsof -nP -iTCP:"${pair#*:}" -sTCP:LISTEN >/dev/null 2>&1; then busy="$busy ${pair#*:}"; fi
done
if [[ -n "$busy" ]]; then
  echo "ci ports already in use:${busy} (is another ci:local running? docker compose -p ${PROJECT} ps)" >&2
  trap - EXIT
  rm -rf "$run_dir"
  exit 1
fi
if [[ -n "$(docker compose -p "$PROJECT" ps -aq 2>/dev/null)" ]]; then
  echo "a ${PROJECT} compose project already exists (another ci:local run?): docker compose -p ${PROJECT} ps" >&2
  trap - EXIT
  rm -rf "$run_dir"
  exit 1
fi

# --- clone at the ref, plus the named working-tree paths
say "ref ${ref} (${sha:0:12}) -> ${wt}"
git clone --quiet --no-checkout --local "$ROOT" "$wt"
if ! git -C "$wt" cat-file -e "${sha}^{commit}" 2>/dev/null; then
  git -C "$wt" fetch --quiet origin "$sha"
fi
git -C "$wt" checkout --quiet --detach "$sha"

if [[ ${#apply_paths[@]} -gt 0 ]]; then
  for p in "${apply_paths[@]}"; do
    say "apply working tree: ${p}"
    git -C "$ROOT" diff --binary "$sha" -- "$p" >"${run_dir}/apply.patch"
    if [[ -s "${run_dir}/apply.patch" ]]; then
      git -C "$wt" apply --index --whitespace=nowarn "${run_dir}/apply.patch"
    fi
    rm -f "${run_dir}/apply.patch"
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      mkdir -p "$(dirname "${wt}/${f}")"
      cp -p "${ROOT}/${f}" "${wt}/${f}"
      git -C "$wt" add -- "$f"
    done < <(git -C "$ROOT" ls-files --others --exclude-standard -- "$p")
  done
fi
if [[ ${#patches[@]} -gt 0 ]]; then
  for p in "${patches[@]}"; do
    say "apply patch: ${p}"
    git -C "$wt" apply --index --whitespace=nowarn "$p"
  done
fi
if ! git -C "$wt" diff --cached --quiet; then
  git -C "$wt" -c user.name=ci-local -c user.email=ci-local@localhost -c commit.gpgsign=false \
    commit --quiet -m "ci-local: uncommitted changes under test"
fi

# --- .env for the clone: .env.example with ci ports, separate compose project
write_env() {
  local sed_args=() pair key new old
  for pair in $CI_PORTS; do
    key="${pair%%:*}"
    new="${pair#*:}"
    old="$(sed -n "s/^${key}=\([0-9][0-9]*\)\$/\1/p" "${wt}/.env.example")"
    [[ -n "$old" ]] || { echo ".env.example has no ${key}" >&2; return 1; }
    sed_args+=(-e "s/^${key}=${old}\$/${key}=${new}/")
    # URLs built from the port (DATABASE_URL, REDIS_URL, STALWART_URL, MAIL_TRANSPORT_URL, APP_URL, ...)
    if [[ "$old" -ge 40000 ]]; then sed_args+=(-e "s/:${old}\([^0-9]\)/:${new}\1/g" -e "s/:${old}\$/:${new}/"); fi
  done
  sed "${sed_args[@]}" "${wt}/.env.example" >"${wt}/.env"
  printf '\n# ci-local: separate compose project (containers, volumes, network)\nCOMPOSE_PROJECT_NAME=%s\n' "$PROJECT" >>"${wt}/.env"
  # Nothing may still point at a dev port.
  for pair in $CI_PORTS; do
    key="${pair%%:*}"
    old="$(sed -n "s/^${key}=\([0-9][0-9]*\)\$/\1/p" "${wt}/.env.example")"
    if [[ "$old" -ge 40000 ]] && grep -Eq "(=|:)${old}([^0-9]|\$)" "${wt}/.env"; then
      echo "ci .env still references dev port ${old}" >&2
      return 1
    fi
  done
}
write_env

# Only what CI's defaults would otherwise supply: lib.sh's apps_up reads the app ports from the shell, the RBAC
# harness takes WEB_URL, and compose commands run anywhere in the clone use the ci project. Everything else comes
# from the clone's .env exactly as in CI (exporting e.g. TEST_DATABASE_URL would make vitest.int skip loading .env).
for key in WEB_DEV_PORT SITE_DEV_PORT WEBMAIL_DEV_PORT; do export "${key}=$(ci_port "$key")"; done
WEB_URL="http://127.0.0.1:$(ci_port WEB_DEV_PORT)"
export WEB_URL COMPOSE_PROJECT_NAME="$PROJECT"
export CI_LOCAL_SHIFTED_MAIL_PORTS=1 CI=true NEXT_TELEMETRY_DISABLED=1 HUSKY=0
unset GITHUB_SHA RUNNER_TEMP

# --- run
results=()
run_step() { # name script -> 0/1, logs to ${logs}/<name>.log
  local name="$1" script="$2" start rc
  start=$(date +%s)
  say "${name}: running (log: ${logs}/${name}.log)"
  # lib.sh writes the app servers' log to $RUNNER_TEMP: keep it with the job log.
  export RUNNER_TEMP="${logs}/${name}-runner"
  mkdir -p "$RUNNER_TEMP"
  set -m
  if [[ $verbose -eq 1 ]]; then
    (cd "$wt" && "$script" 2>&1 | tee "${logs}/${name}.log") &
  else
    (cd "$wt" && "$script" >"${logs}/${name}.log" 2>&1) &
  fi
  job_pid=$!
  set +m
  rc=0
  wait "$job_pid" || rc=$?
  kill_job
  local secs=$(($(date +%s) - start))
  # Playwright retries once in CI: a pass that needed a retry is reported, never hidden.
  local flaky
  flaky="$(sed -nE 's/^ *([0-9]+) flaky$/\1/p' "${logs}/${name}.log" | tail -n 1)"
  if [[ $rc -eq 0 ]]; then
    results+=("${name}|pass${flaky:+ (${flaky} flaky)}|${secs}")
    say "${name}: pass${flaky:+, ${flaky} flaky} ($(fmt_secs "$secs"))"
  else
    results+=("${name}|FAIL (exit ${rc})|${secs}")
    say "${name}: FAIL, exit ${rc} ($(fmt_secs "$secs")); last lines:"
    [[ $verbose -eq 1 ]] || tail -n 60 "${logs}/${name}.log" | sed 's/^/    /'
  fi
  save_artifacts "$name"
  return "$rc"
}
# Like ci.yml's artifact upload, also after a pass (a flaky test that passed on retry leaves its first failure
# here). Screenshots and page snapshots only: traces and the HTML report can hold typed demo passwords, and any
# password field value in a snapshot is masked.
save_artifacts() {
  local dest="${logs}/$1-artifacts" f
  [[ -d "${wt}/test-results" ]] || return 0
  while IFS= read -r -d '' f; do
    mkdir -p "${dest}/$(dirname "$f")"
    if [[ "$f" == *.md ]]; then
      sed -E 's/(textbox "[^"]*[Pp]ass[^"]*"[^:]*): .*/\1: [masked]/' "${wt}/${f}" >"${dest}/${f}"
    else
      cp "${wt}/${f}" "${dest}/${f}"
    fi
  done < <(cd "$wt" && find test-results -type f \( -name '*.png' -o -name '*.md' \) -print0)
  if [[ -d "$dest" ]]; then say "$1: screenshots and page snapshots of failed attempts in ${dest}"; fi
}
fmt_secs() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

# Each CI job starts from a fresh checkout + setup. Remember what exists after setup (node_modules, the ci .env,
# anything install scripts generate) and, before each job, remove everything else a previous job left behind.
baseline_args=()
snapshot_clone() {
  local f
  baseline_args=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && baseline_args+=(-e "/${f}")
  done < <(git -C "$wt" ls-files --others --directory)
}
reset_clone() {
  if [[ ${#baseline_args[@]} -gt 0 ]]; then
    git -C "$wt" clean -ffdxq "${baseline_args[@]}"
  else
    git -C "$wt" clean -ffdxq
  fi
  git -C "$wt" checkout --quiet -- .
}

total_start=$(date +%s)
failed=0
if run_step setup ./.cicd/setup.sh; then
  snapshot_clone
  for job in $selected; do
    reset_clone
    case "$STACK_JOBS" in *" $job "*) stack_down ;; esac
    # The security job needs full history (ci.yml: fetch-depth 0); the clone has it.
    run_step "$job" "./.cicd/${job}.sh" || failed=1
    case "$STACK_JOBS" in *" $job "*) stack_down ;; esac
  done
else
  failed=1
fi
total=$(($(date +%s) - total_start))

printf '\n%-12s %-20s %s\n' "job" "result" "time"
printf '%-12s %-20s %s\n' "---" "------" "----"
for r in "${results[@]}"; do
  IFS='|' read -r n s t <<<"$r"
  printf '%-12s %-20s %s\n' "$n" "$s" "$(fmt_secs "$t")"
done
printf '%-12s %-20s %s\n' "total" "$([[ $failed -eq 0 ]] && echo pass || echo FAIL)" "$(fmt_secs "$total")"
extra=""
if [[ ${#apply_paths[@]} -gt 0 ]]; then extra="${extra} + working tree of: ${apply_paths[*]}"; fi
if [[ ${#patches[@]} -gt 0 ]]; then extra="${extra} + patches: ${patches[*]}"; fi
printf 'ref %s (%s)%s\n' "$ref" "${sha:0:12}" "$extra"
exit "$failed"
