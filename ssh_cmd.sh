#!/usr/bin/expect
match_max 100000
set timeout -1
# We pass the command to run as the first argument to this script
spawn ssh -o StrictHostKeyChecking=no -i ~/.ssh/ai_platform root@46.62.135.86 [lindex $argv 0]
expect {
    "Enter passphrase for key" {
        send "1991Dimas\r"
        exp_continue
    }
    eof {
        exit [lindex [wait] 3]
    }
}
