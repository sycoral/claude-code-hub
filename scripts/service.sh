#!/bin/bash
# CCH service management script
# Usage: ./scripts/service.sh {start|stop|restart|status|log}

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PORT="${APP_PORT:-23000}"
PID_FILE="$APP_DIR/app.pid"
LOG_FILE="$APP_DIR/app.log"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "CCH is already running (PID: $(cat "$PID_FILE"))"
    return 1
  fi

  echo "Starting CCH on port $APP_PORT..."
  cd "$APP_DIR"
  nohup bash -c "set -a; source .env; set +a; exec bun run start --port $APP_PORT" > "$LOG_FILE" 2>&1 &
  local shell_pid=$!
  sleep 3

  # Find the actual next-server PID (child of bun)
  local server_pid=$(pgrep -f "next-server" | head -1)
  echo "${server_pid:-$shell_pid}" > "$PID_FILE"

  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    echo "CCH started (PID: $server_pid, Port: $APP_PORT)"
  else
    echo "CCH failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    echo "CCH is not running (no PID file)"
    # Try to find and kill by process name (bun or next-server)
    local pid=$(pgrep -f "bun run start.*$APP_PORT" || pgrep -f "next-server")
    if [ -n "$pid" ]; then
      echo "Found orphan process $pid, killing..."
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
      echo "Killed"
    fi
    return 0
  fi

  local pid=$(cat "$PID_FILE")
  echo "Stopping CCH (PID: $pid)..."
  kill "$pid" 2>/dev/null
  sleep 2

  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing..."
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi

  rm -f "$PID_FILE"
  echo "CCH stopped"
}

restart() {
  stop
  sleep 1
  start
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "CCH is running (PID: $(cat "$PID_FILE"), Port: $APP_PORT)"
  else
    echo "CCH is not running"
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
  fi
}

log() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    echo "No log file found at $LOG_FILE"
  fi
}

case "$1" in
  start)   start ;;
  stop)    stop ;;
  restart) restart ;;
  status)  status ;;
  log)     log ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|log}"
    echo ""
    echo "  start    Start CCH service"
    echo "  stop     Stop CCH service"
    echo "  restart  Restart CCH service"
    echo "  status   Check if CCH is running"
    echo "  log      Tail the log file"
    echo ""
    echo "Environment:"
    echo "  APP_PORT  Override port (default: 23000)"
    exit 1
    ;;
esac
