# Certificates

## `supabase-prod-ca-2021.crt`

The **Supabase Root 2021 CA**, which signs the certificate the connection
pooler presents.

Supabase runs a private CA — the root is self-signed and appears in no public
trust store — so Node rejects the connection with `self-signed certificate in
certificate chain` unless this root is supplied explicitly. Pinning it is
stronger than the public-CA case: only certificates from this one issuer are
accepted, so a mis-issuance by any of the ~150 public CAs Node otherwise
trusts cannot impersonate the database.

**This is a public certificate, not a secret.** It contains no key material and
is committed deliberately.

### Provenance

Downloaded over HTTPS from Supabase's own distribution bucket, authenticated by
a public CA, and then checked against the root actually presented by the
pooler:

```
SHA-256  80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:
         82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```

Both matched, and `openssl s_client -CAfile` then returned `Verify return code:
0 (ok)`. The fingerprint is recorded here so the file can be re-verified
without trusting the connection it is meant to secure — checking a CA against
the server that presents it is circular on its own.

### Expiry

`notAfter = 2031-04-26`. Supabase will publish a successor before then; when
they do, add it alongside rather than replacing this one, so connections keep
working across the rollover.

To re-verify:

```bash
openssl x509 -in backend/certs/supabase-prod-ca-2021.crt -noout -fingerprint -sha256
```
