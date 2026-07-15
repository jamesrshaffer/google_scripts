#!/bin/bash
# ha-vm-backup.sh -- live full-image backup of HomeAssistant VM to NAS.
# virsh backup-begin (no VM downtime), staged locally, verified, copied to NAS.

set -uo pipefail

VM="HomeAssistant"
STAGE="/home/jim/vm-backups"
SHARE="//192.168.1.158/ha_backups"
CREDS="/etc/samba/nas-creds-jim"
MNT="/mnt/ha_vm_backup"
NASDIR="vm_images"
KEEP=4
STAMP=$(TZ=America/New_York date +%Y-%m-%d_%H%M)
IMG="$STAGE/haos_${STAMP}.qcow2"
XML="$STAGE/haos_${STAMP}.xml"
LOG="/var/log/ha-vm-backup.log"

MOUNTED=0
FROZE=0

log() { echo "$(TZ=America/New_York date '+%F %T %Z') $*" | tee -a "$LOG"; }

cleanup() {
  [ "$FROZE" = 1 ] && virsh domfsthaw "$VM" >/dev/null 2>&1 && FROZE=0
  [ "$MOUNTED" = 1 ] && umount "$MNT" >/dev/null 2>&1 && MOUNTED=0
}
trap cleanup EXIT

fail() { log "ERROR: $*"; exit 1; }

# --- preflight ---
[ "$(virsh domstate "$VM")" = "running" ] || fail "VM not running"
virsh domjobinfo "$VM" | grep -q "None" || fail "another virsh job is active"
mkdir -p "$STAGE"
avail=$(df --output=avail -BG "$STAGE" | tail -1 | tr -dc '0-9')
[ "$avail" -ge 80 ] || fail "less than 80G free in $STAGE (${avail}G)"

# --- backup job xml ---
BXML=$(mktemp)
cat > "$BXML" <<EOF2
<domainbackup>
  <disks>
    <disk name='vda' type='file'>
      <target file='$IMG'/>
      <driver type='qcow2'/>
    </disk>
  </disks>
</domainbackup>
EOF2

# --- freeze -> begin -> thaw ---
if virsh domfsfreeze "$VM" >/dev/null 2>&1; then
  FROZE=1
else
  log "WARN: fsfreeze failed; backup will be crash-consistent"
fi
virsh backup-begin "$VM" "$BXML" >/dev/null
RC=$?
if [ "$FROZE" = 1 ]; then
  virsh domfsthaw "$VM" >/dev/null && FROZE=0
fi
rm -f "$BXML"
[ "$RC" -eq 0 ] || fail "backup-begin failed"
log "backup job started -> $IMG"

# --- wait for completion (max 60 min) ---
done=0
for i in $(seq 1 240); do
  sleep 15
  if virsh domjobinfo "$VM" | grep -q "None"; then done=1; break; fi
done
[ "$done" -eq 1 ] || fail "backup job did not finish within 60 min"

# --- verify + dump domain xml ---
qemu-img check -q "$IMG" || fail "qemu-img check failed on $IMG"
virsh dumpxml "$VM" > "$XML"
log "image verified clean: $(du -h "$IMG" | cut -f1)"

# --- copy to NAS ---
mkdir -p "$MNT"
mount -t cifs "$SHARE" "$MNT" -o "credentials=$CREDS,vers=3.0,iocharset=utf8" \
  || fail "NAS mount failed"
MOUNTED=1
mkdir -p "$MNT/$NASDIR"
rsync -t "$IMG" "$XML" "$MNT/$NASDIR/" || fail "copy to NAS failed"
log "copied to NAS: $NASDIR/$(basename "$IMG")"

# --- rotate NAS copies (keep $KEEP newest) ---
ls -1t "$MNT/$NASDIR"/haos_*.qcow2 2>/dev/null | tail -n +$((KEEP+1)) | while read -r f; do
  rm -f "$f" "${f%.qcow2}.xml"
  log "rotated out: $(basename "$f")"
done

# --- clear SMB #recycle on the share ---
if [ -d "$MNT/#recycle" ]; then
  find "$MNT/#recycle" -mindepth 1 -delete 2>/dev/null
  log "cleared #recycle"
fi

umount "$MNT" && MOUNTED=0

# --- keep only newest local staging copy ---
ls -1t "$STAGE"/haos_*.qcow2 2>/dev/null | tail -n +2 | while read -r f; do
  rm -f "$f" "${f%.qcow2}.xml"
done

log "SUCCESS: backup complete"
