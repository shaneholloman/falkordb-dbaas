#!/bin/bash
set -u

aof_rewrite=$(redis-cli -a "$(cat /run/secrets/adminpassword)" --no-auth-warning info persistence | grep "aof_rewrite_in_progress" | grep ':1')
aof_pending=$(redis-cli -a "$(cat /run/secrets/adminpassword)" --no-auth-warning info persistence | grep "aof_pending_rewrite" | grep ':1')
if [[ -z "$aof_rewrite" && -z "$aof_pending" ]]; then
  echo "FORK_KILL_FAILED: neither AOF rewrite nor pending rewrite are active, expected at least one to be 1" >&2
  exit 1
fi
redis_pid=$(redis-cli -a "$(cat /run/secrets/adminpassword)" --no-auth-warning info server | grep process_id | cut -d':' -f2 | tr -d '\n\r')
if [[ -z "$redis_pid" ]]; then
  echo "FORK_KILL_FAILED: Could not determine Redis server PID" >&2
  exit 1
fi
forks=$(cat /proc/"$redis_pid"/task/"$redis_pid"/children)

if [[ -z "$forks" ]]; then
  echo "FORK_KILL_FAILED: bgsave/aof in progress but no child process found in /proc/$redis_pid/task/$redis_pid/children" >&2
  exit 1
fi

fork_count=$(echo "$forks" | wc -w)

if [[ "$fork_count" -gt 1 ]]; then
  echo "FORK_KILL_FAILED: More than one child process found, cannot determine which one to kill" >&2
  exit 1
fi

p=$(echo "$forks" | awk '{print $1}')

if [[ "$redis_pid" -eq "$p" ]]; then
  echo "FORK_KILL_FAILED: Child process ID is the same as the Redis server process ID, cannot kill" >&2
  exit 1
fi

if ! kill -9 "$p"; then
  echo "FORK_KILL_FAILED: Failed to kill process $p" >&2
  exit 1
fi
echo "killed the process $p"