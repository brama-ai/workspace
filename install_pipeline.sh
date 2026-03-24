#!/bin/bash
set -e
export SSH_AUTH_SOCK
export SSH_AGENT_PID
eval $(ssh-agent -s) > /dev/null
expect -c '
spawn ssh-add /Users/nmdimas/.ssh/ai_platform
expect "Enter passphrase"
send "1991Dimas\r"
expect eof
'
ssh -o StrictHostKeyChecking=no root@46.62.135.86 "echo 'SSH Key authenticated successfully!'"
