"""Minimal S3-compatible client for Cloudflare R2, standard library only.

boto3 would work, but it is a ~50MB dependency and this has to run under Termux
on a phone. Only four operations are needed, so the AWS SigV4 signing is done
here directly.

R2 specifics: endpoint is https://<account_id>.r2.cloudflarestorage.com and the
signing region is "auto".
"""
import datetime
import hashlib
import hmac
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ALGORITHM = "AWS4-HMAC-SHA256"
SERVICE = "s3"
REGION = "auto"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


class R2Error(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, datestamp: str, region: str, service: str) -> bytes:
    key = _hmac(f"AWS4{secret}".encode("utf-8"), datestamp)
    key = _hmac(key, region)
    key = _hmac(key, service)
    return _hmac(key, "aws4_request")


def authorization(
    method: str,
    host: str,
    path: str,
    query: str,
    headers: dict,
    payload_hash: str,
    access_key: str,
    secret_key: str,
    amzdate: str,
    datestamp: str,
    region: str = REGION,
    service: str = SERVICE,
) -> str:
    """Build the SigV4 Authorization header value.

    Split out from the request path so it can be checked against the AWS
    published test vectors.
    """
    lowered = {k.lower(): str(v).strip() for k, v in headers.items()}
    names = sorted(lowered)
    signed = ";".join(names)
    canonical_headers = "".join(f"{n}:{lowered[n]}\n" for n in names)
    canonical_request = "\n".join(
        [method, path, query, canonical_headers, signed, payload_hash]
    )
    scope = f"{datestamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            ALGORITHM,
            amzdate,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        signing_key(secret_key, datestamp, region, service),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return (
        f"{ALGORITHM} Credential={access_key}/{scope}, "
        f"SignedHeaders={signed}, Signature={signature}"
    )


def quote_key(key: str) -> str:
    # S3 canonical URIs encode each segment once; "/" stays a separator and
    # unreserved characters (-_.~ and alphanumerics) are never escaped.
    return urllib.parse.quote(key, safe="/")


class Bucket:
    def __init__(self, account_id: str, bucket: str, access_key: str, secret_key: str, timeout: int = 60):
        self.account_id = account_id.strip()
        self.bucket = bucket.strip()
        self.access_key = access_key.strip()
        self.secret_key = secret_key.strip()
        self.host = f"{self.account_id}.r2.cloudflarestorage.com"
        self.scheme = "https"  # overridden by tests to point at a local endpoint
        self.timeout = timeout

    def _request(self, method: str, key: str, body: bytes | None = None,
                 query: str = "", content_type: str | None = None) -> bytes:
        payload = body or b""
        payload_hash = hashlib.sha256(payload).hexdigest() if payload else EMPTY_SHA256
        now = datetime.datetime.now(datetime.timezone.utc)
        amzdate = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")

        path = f"/{self.bucket}"
        if key:
            path += f"/{quote_key(key)}"

        headers = {
            "host": self.host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amzdate,
        }
        if content_type:
            headers["content-type"] = content_type

        headers["Authorization"] = authorization(
            method, self.host, path, query, headers, payload_hash,
            self.access_key, self.secret_key, amzdate, datestamp,
        )

        url = f"{self.scheme}://{self.host}{path}"
        if query:
            url += f"?{query}"
        request = urllib.request.Request(url, data=payload or None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            raise R2Error(exc.code, _s3_message(exc.read())) from None
        except urllib.error.URLError as exc:
            raise R2Error(
                0,
                f"could not reach {self.host} - check the account ID and your "
                f"internet connection ({exc.reason})",
            ) from None

    def put(self, key: str, body: bytes, content_type: str = "application/octet-stream") -> None:
        self._request("PUT", key, body=body, content_type=content_type)

    def get(self, key: str) -> bytes:
        return self._request("GET", key)

    def delete(self, key: str) -> None:
        self._request("DELETE", key)

    def list_keys(self, prefix: str = "") -> list[str]:
        keys: list[str] = []
        token = None
        while True:
            params = {"list-type": "2", "max-keys": "1000"}
            if prefix:
                params["prefix"] = prefix
            if token:
                params["continuation-token"] = token
            # Canonical query strings must be sorted by key.
            query = "&".join(
                f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
                for k, v in sorted(params.items())
            )
            root = ET.fromstring(self._request("GET", "", query=query))
            ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
            keys.extend(e.text for e in root.findall(".//s3:Contents/s3:Key", ns) if e.text)
            truncated = root.findtext("s3:IsTruncated", default="false", namespaces=ns)
            token = root.findtext("s3:NextContinuationToken", namespaces=ns)
            if truncated.lower() != "true" or not token:
                return keys

    def check(self) -> str:
        """Cheap credential/permission probe used by the settings dialog."""
        self.list_keys(prefix="__connection_check__")
        return "ok"


def _s3_message(body: bytes) -> str:
    try:
        root = ET.fromstring(body)
        code = root.findtext("Code") or root.findtext(".//Code") or ""
        message = root.findtext("Message") or root.findtext(".//Message") or ""
        return f"{code}: {message}".strip(": ") or body.decode("utf-8", "ignore")[:200]
    except ET.ParseError:
        return body.decode("utf-8", "ignore")[:200] or "no response body"
