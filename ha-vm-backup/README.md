# ha-vm-backup — live full-image backup of the Home Assistant VM

Host: EQR (192.168.1.205), Linux Mint 22.3, libvirt 10.0 / QEMU-KVM
VM:   HomeAssistant (HAOS, 192.168.1.142)
Disk: /home/jim/Downloads/haos_ova-17.1.qcow2 (150G virtual, ~68G allocated)

## Design

- `virsh backup-begin` push backup: VM stays running — no downtime, no USB
  re-enumeration of the Z-Wave stick.
- Filesystem-consistent: `domfsfreeze` -> `backup-begin` -> `domfsthaw`
  (guest frozen <1 second; falls back to crash-consistent with a WARN if
  the guest agent doesn't respond).
- Staged to /home/jim/vm-backups, verified with `qemu-img check`, domain
  XML dumped alongside.
- Copied to NAS //192.168.1.158/ha_backups/vm_images/ via CIFS
  (creds /etc/samba/nas-creds-jim). Share mounted at /mnt/ha_vm_backup
  only for the copy, then unmounted (anti-ransomware pattern, matches
  restic job).
- Rotation: 4 newest image+XML pairs kept on NAS; newest pair also kept
  locally for fast restore. Share #recycle cleared each run.
- Log: /var/log/ha-vm-backup.log (EDT, summary lines only).

## Schedule

systemd timer: Sun 03:30 EDT, Persistent=true. Slot chosen to follow the
02:00 restic run and finish before HA's native backup (~04:50).
Observed runtime ~45 min (11 min backup + ~33 min copy at ~1 Gbps).

## Install

    sudo cp ha-vm-backup.sh /usr/local/sbin/ && sudo chmod 755 /usr/local/sbin/ha-vm-backup.sh
    sudo cp ha-vm-backup.service ha-vm-backup.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now ha-vm-backup.timer

## Restore

1. Copy haos_<date>.qcow2 (and .xml) from NAS vm_images/ to EQR.
2. VM defined but disk lost/corrupt: `virsh shutdown HomeAssistant`,
   replace the disk file at the path in the domain XML, `virsh start`.
3. VM definition lost: edit `<source file=...>` in haos_<date>.xml to the
   restored image path, then `virsh define haos_<date>.xml` and
   `virsh start HomeAssistant`.

Image is a point-in-time fs-consistent snapshot; HA boots as of backup time.
HA config-level restores should use the native nightly backups (.tar files
in the share root) instead.

## Notes

- vm_images/ is excluded in nas-backup.sh so the ~68G images don't inflate
  the restic repo. NAS rotation is the retention layer for images.
