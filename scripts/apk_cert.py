"""Stampa l'impronta SHA-256 del certificato con cui è firmato un APK (schema v2/v3).

Uso: python3 scripts/apk_cert.py app.apk"""
import sys, struct, hashlib
d = open(sys.argv[1], 'rb').read()
eocd = d.rfind(b'PK\x05\x06')
cd_off = struct.unpack('<I', d[eocd+16:eocd+20])[0]
assert d[cd_off-16:cd_off] == b'APK Sig Block 42', 'no signing block'
size = struct.unpack('<Q', d[cd_off-24:cd_off-16])[0]
blk = d[cd_off-size-8+8:cd_off-24]
i = 0
def lp(b, o):
    n = struct.unpack('<I', b[o:o+4])[0]; return b[o+4:o+4+n], o+4+n
while i < len(blk):
    n = struct.unpack('<Q', blk[i:i+8])[0]; bid = struct.unpack('<I', blk[i+8:i+12])[0]; val = blk[i+12:i+8+n]; i += 8+n
    if bid in (0x7109871a, 0xf05368c0):
        signers, _ = lp(val, 0); signer, _ = lp(signers, 0); sd, _ = lp(signer, 0)
        digests, o = lp(sd, 0); certs, _ = lp(sd, o); cert, _ = lp(certs, 0)
        print('v2' if bid == 0x7109871a else 'v3', hashlib.sha256(cert).hexdigest().upper())
