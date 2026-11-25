#!/bin/sh
# Run this INSIDE a Railway sandbox (or any target host) before building anything.
# It answers: can we use KVM / binder (redroid path), or are we stuck with QEMU TCG?
echo "== arch / cpu";  uname -srm; nproc; grep -m1 'model name' /proc/cpuinfo
echo "== memory";      grep -E 'MemTotal|SwapTotal' /proc/meminfo
[ -r /sys/fs/cgroup/memory.max ] && echo "cgroup memory.max: $(cat /sys/fs/cgroup/memory.max)"
echo "== disk";        df -h / /data /tmp 2>/dev/null
echo "== whoami";      id
KVM=no;  [ -c /dev/kvm ] && KVM=yes
BINDER=no
grep -qw binder /proc/filesystems && BINDER=yes
[ -d /sys/module/binder_linux ] && BINDER=yes
(modprobe binder_linux 2>/dev/null && BINDER=yes) || true
(zcat /proc/config.gz 2>/dev/null | grep -E 'CONFIG_ANDROID_BINDER(FS|_IPC)=' ) || echo "(no /proc/config.gz)"
echo "== docker";      (docker info >/dev/null 2>&1 && echo "docker usable") || echo "no usable docker daemon"
echo "== qemu";        command -v qemu-system-x86_64 || echo "qemu not installed (apt-get install qemu-system-x86)"
echo
echo "RESULT  /dev/kvm: $KVM   binder: $BINDER"
if [ "$KVM" = yes ]; then echo "-> Use QEMU with -accel kvm (fast). Best case.";
elif [ "$BINDER" = yes ]; then echo "-> redroid path may work (needs privileged container/namespaces). Try it: it avoids emulation entirely.";
else echo "-> Only QEMU TCG is possible: ~10x+ slowdown, Android boot takes many minutes. See FEASIBILITY.md."; fi
