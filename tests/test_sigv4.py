"""Cross-check our SigV4 against botocore, an independent trusted implementation.

botocore signs first; we reuse the exact timestamp and header set it signed, then
compare signatures. Agreement across several request shapes (GET, PUT with body,
unicode key, query string) means our signing matches the AWS spec.
"""
import sys

sys.path.insert(0, r"C:\Users\test\Desktop\IT\Photo_map")

import hashlib  # noqa: E402

from botocore.auth import S3SigV4Auth  # noqa: E402
from botocore.awsrequest import AWSRequest  # noqa: E402
from botocore.credentials import Credentials  # noqa: E402

from backend import r2  # noqa: E402

ACCESS = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
HOST = "abc123.r2.cloudflarestorage.com"
creds = Credentials(ACCESS, SECRET)


def compare(label, method, path, query, body, extra_headers=None):
    payload = body or b""
    payload_hash = hashlib.sha256(payload).hexdigest() if payload else r2.EMPTY_SHA256

    url = f"https://{HOST}{path}"
    if query:
        url += f"?{query}"
    headers = {"host": HOST, "x-amz-content-sha256": payload_hash}
    if extra_headers:
        headers.update(extra_headers)

    request = AWSRequest(method=method, url=url, data=payload, headers=dict(headers))
    # S3SigV4Auth, not the generic SigV4Auth: S3 does not normalize or re-encode
    # an already-encoded path, and R2 follows S3 semantics.
    S3SigV4Auth(creds, "s3", "auto").add_auth(request)
    theirs = request.headers["Authorization"]
    amzdate = request.headers["X-Amz-Date"]
    datestamp = amzdate[:8]
    their_sig = theirs.split("Signature=")[1].strip()
    their_signed = theirs.split("SignedHeaders=")[1].split(",")[0].strip()

    # Sign the identical header set botocore signed, at the identical instant.
    ours_headers = {n: request.headers[n] for n in their_signed.split(";")}
    ours = r2.authorization(
        method, HOST, path, query, ours_headers, payload_hash,
        ACCESS, SECRET, amzdate, datestamp, region="auto", service="s3",
    )
    our_sig = ours.split("Signature=")[1].strip()
    our_signed = ours.split("SignedHeaders=")[1].split(",")[0].strip()

    ok = our_sig == their_sig and our_signed == their_signed
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    print(f"        signed headers  {our_signed}")
    print(f"        botocore        {their_sig}")
    print(f"        ours            {our_sig}")
    if not ok:
        print(f"        header mismatch: botocore={their_signed!r} ours={our_signed!r}")
    return ok


results = [
    compare("GET list-objects-v2", "GET", "/photomap", "list-type=2&max-keys=1000", None),
    compare("PUT manifest.json", "PUT", "/photomap/manifest.json", "", b'{"v":1,"n":3}',
            {"content-type": "application/json"}),
    compare("PUT thumbnail", "PUT", "/photomap/t/ab12cd34ef.jpg", "", b"\xff\xd8\xff\xe0binary",
            {"content-type": "image/jpeg"}),
    compare("DELETE object", "DELETE", "/photomap/t/deadbeef.jpg", "", None),
    compare("PUT unicode key", "PUT", "/photomap/" + r2.quote_key("caf\u00e9/sk\u00e5l.jpg"), "", b"x",
            {"content-type": "image/jpeg"}),
    compare("PUT empty body", "PUT", "/photomap/empty", "", b""),
    compare("GET paginated", "GET", "/photomap",
            "continuation-token=1%2FabcDEF%2B%3D&list-type=2&prefix=t%2F", None),
]

print()
if all(results):
    print(f"ALL {len(results)} SIGNATURES MATCH BOTOCORE")
else:
    print(f"{results.count(False)} of {len(results)} FAILED")
    sys.exit(1)
