# Paigutus

Lühike kasutusjuhend projekti ja VPS deploymenti jaoks.

## VPS setup skript
Skript asub `scripts/setup_vps.sh` ja paigaldab Node.js, loob deploy-kasutaja, kloonib repo, installeerib sõltuvused, loob `systemd` teenuse ja konfigureerib tulemüüri.

Näide käivitamiseks (VPS-is, `sudo`):

```bash
sudo bash scripts/setup_vps.sh https://github.com/JoonasMagi/paigutus.git /var/www/paigutus deploy 3000
```

Parameetrid:
- `git_repo_url` (valikuline) — GitHub repo URL, vaikimisi `https://github.com/JoonasMagi/paigutus.git`
- `app_dir` (valikuline) — rakenduse asukoht VPS-is, vaikimisi `/var/www/paigutus`
- `deploy_user` (valikuline) — süsteemi kasutaja, vastu võtab repo failide omandi, vaikimisi `deploy`
- `port` (valikuline) — teenuse kuulamise port, vaikimisi `3000`

Pärast skripti lõpetamist:

- Vaata teenuse staatust: `sudo systemctl status paigutus.service`
- Vaata logisid: `sudo journalctl -u paigutus.service -f`

Märkus: kui soovid SSH-ühenduse ilma paroolita (soovitus VPS-i haldamiseks), loo ja lisa oma avalik võti `~/.ssh/authorized_keys` deploy-kasutaja kodukataloogi.
# paigutus