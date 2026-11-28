# hermes-fleet-cli-path: login shells must keep image and profile CLIs.
# /etc/profile replaces PATH with the Debian default, which drops hermes.
_hermes_cli_prepend() {
  _dir=$1
  [ -n "$_dir" ] && [ -d "$_dir" ] || return 0
  case ":${PATH}:" in
    *":${_dir}:"*) ;;
    *) PATH="${_dir}:${PATH}" ;;
  esac
}
_hermes_cli_prepend /opt/data/.local/bin
_hermes_cli_prepend /opt/data/bin
_hermes_cli_prepend /opt/data/home/.local/bin
_hermes_cli_prepend "${HOME:-}/.local/bin"
_hermes_cli_prepend /opt/hermes/.venv/bin
_hermes_cli_prepend /opt/hermes/bin
unset -f _hermes_cli_prepend
unset _dir
export PATH
