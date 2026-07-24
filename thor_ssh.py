import sys, os, paramiko

host = os.environ.get('THOR_HOST', '192.168.219.102')
user = os.environ.get('THOR_USER')
if not user:
    print('set THOR_USER', file=sys.stderr)
    sys.exit(2)

cmd = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else 'uname -a'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    key_path = os.environ.get('THOR_KEY_PATH')
    pw = os.environ.get('THOR_PASS')
    if key_path:
        client.connect(host, username=user, key_filename=key_path, timeout=20)
    elif pw is not None:
        client.connect(host, username=user, password=pw, look_for_keys=False, allow_agent=False, timeout=20)
    else:
        print('set THOR_PASS or THOR_KEY_PATH', file=sys.stderr)
        sys.exit(2)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    rc = stdout.channel.recv_exit_status()
    if out:
        print(out, end='')
    if err:
        print(err, end='', file=sys.stderr)
    sys.exit(rc)
finally:
    client.close()
