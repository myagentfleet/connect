import base64
import hashlib
import io
import json
import os
import stat
import urllib.error
import urllib.request
import zipfile

REPO = "myagentfleet/connect"
SOURCE = "fd173c1c153e1f893494963675472ad4e448a7ce"
BASE_TREE = "b364deed0e5add454e199f84d5d3308df90cab6f"
ARTIFACT = 11640275358
ARCHIVE_SHA256 = "7d18311c6a599774f4d6e3ee9e135036743829f902240e04980a0d65e37b5758"
EXPECTED = {
    "README.md", "PR_DRAFT.md", "requirements-review.json", "status.json",
    "evidence.zip", "index.html", "player-desktop.png", "player-mobile.png",
    "native-recovery.png", "SHA256SUMS", "connect-769-review.zip",
}
REUSED = {
    "README.md": "71528f88bd0557b40dc23c6ba05a043eb14f3989",
    "requirements-review.json": "d36c75f0124a8968c395fd7ab217d934c286b960",
    "PR_DRAFT.md": "2a55c91f080ce864cebd8f60452e776425faf1db",
}

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def git_object(kind, data):
    header = kind.encode() + b" " + str(len(data)).encode() + b"\0"
    return hashlib.sha1(header + data).hexdigest()

def git_tree(entries):
    ordered = sorted(entries, key=lambda e: e["path"].encode() + (b"/" if e["type"] == "tree" else b""))
    data = b""
    for entry in ordered:
        mode = "40000" if entry["type"] == "tree" else entry["mode"]
        data += (mode + " " + entry["path"]).encode() + b"\0" + bytes.fromhex(entry["sha"])
    return git_object("tree", data)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def request(path, method="GET", data=None):
    # This worker can read repository metadata and create blobs only.
    require(method == "GET" or (method == "POST" and path == "git/blobs"), "Unexpected write operation")
    headers = {
        "Authorization": "Bearer " + os.environ["QA769_BLOB_TOKEN"],
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    payload = None if data is None else json.dumps(data).encode()
    if payload is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        "https://api.github.com/repos/" + REPO + "/" + path,
        headers=headers, data=payload, method=method,
    )
    return urllib.request.build_opener(NoRedirect).open(req, timeout=50)

def api(path, method="GET", data=None):
    try:
        with request(path, method, data) as response:
            return json.load(response)
    except Exception:
        raise RuntimeError("GitHub object operation failed: " + method + " " + path) from None

require(os.environ.get("GITHUB_REPOSITORY") == REPO, "Wrong repository")
require(os.environ.get("GITHUB_REF") == "refs/heads/qa/769-review-save", "Wrong QA branch")
require(api("git/ref/heads/fix/769-media-playback")["object"]["sha"] == SOURCE, "Application source changed")
base = api("git/trees/" + BASE_TREE)
require(base["sha"] == BASE_TREE and not base.get("truncated"), "Wrong base tree")
require(not any(e["path"] == "reviews" for e in base["tree"]), "Review directory already exists in source")

try:
    location = None
    try:
        with request(f"actions/artifacts/{ARTIFACT}/zip") as response:
            archive = response.read(15_000_001)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308):
            raise
        location = error.headers.get("Location")
    if location:
        require(location.startswith("https://"), "Expected HTTPS artifact redirect")
        # Follow the GitHub-provided storage link without the API credential.
        with urllib.request.urlopen(location, timeout=45) as response:
            archive = response.read(15_000_001)
    require(len(archive) <= 15_000_000, "Oversized review artifact")
    require(sha256(archive) == ARCHIVE_SHA256, "Review artifact digest mismatch")
except Exception:
    raise RuntimeError("Could not recover the original verified review artifact") from None

files = {}
with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
    require(zipped.testzip() is None, "Corrupt artifact")
    for entry in zipped.infolist():
        parts = entry.filename.split("/")
        require(not entry.filename.startswith("/") and ".." not in parts and "\\" not in entry.filename, "Unsafe archive path")
        require(not stat.S_ISLNK(entry.external_attr >> 16), "Archive contains a symlink")
        if entry.is_dir():
            continue
        name = parts[-1]
        require(name in EXPECTED and name not in files and entry.file_size < 30_000_000, "Unexpected artifact entry")
        files[name] = zipped.read(entry)
require(set(files) == EXPECTED, "Review file set differs")
checksums = {}
for line in files["SHA256SUMS"].decode().splitlines():
    digest, name = line.split("  ", 1)
    require(name in files and name not in checksums, "Invalid checksum record")
    checksums[name] = digest
require(set(checksums) == EXPECTED - {"SHA256SUMS", "connect-769-review.zip"}, "Checksum coverage differs")
for name, digest in checksums.items():
    require(sha256(files[name]) == digest, "File hash differs: " + name)
with zipfile.ZipFile(io.BytesIO(files["connect-769-review.zip"])) as zipped:
    expected_members = {"connect-769-review/" + name for name in EXPECTED - {"connect-769-review.zip"}}
    require(set(zipped.namelist()) == expected_members and len(zipped.namelist()) == len(expected_members), "Complete bundle contents differ")
    for name in EXPECTED - {"connect-769-review.zip"}:
        require(zipped.read("connect-769-review/" + name) == files[name], "Standalone and bundled file differ")
requirements = json.loads(files["requirements-review.json"])
require(requirements["sourceSha"] == SOURCE, "Wrong reviewed source")
require(requirements["fullIssueRequirementsSatisfied"] is False, "Completion status differs")

manifest = []
for name, data in sorted(files.items()):
    expected_sha = git_object("blob", data)
    if REUSED.get(name) == expected_sha:
        result = api("git/blobs/" + expected_sha)
        require(result["sha"] == expected_sha, "Reused review blob differs")
    else:
        result = api("git/blobs", "POST", {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        require(result["sha"] == expected_sha, "Uploaded review blob differs")
    manifest.append({"name": name, "size": len(data), "sha256": sha256(data), "sha": expected_sha})
    print("Verified review blob: " + name, flush=True)

review_tree = git_tree([{"path": f["name"], "mode": "100644", "type": "blob", "sha": f["sha"]} for f in manifest])
reviews_tree = git_tree([{"path": "769", "mode": "040000", "type": "tree", "sha": review_tree}])
root_tree = git_tree(base["tree"] + [{"path": "reviews", "mode": "040000", "type": "tree", "sha": reviews_tree}])
require(api("git/ref/heads/fix/769-media-playback")["object"]["sha"] == SOURCE, "Application source changed during transfer")
record = {
    "artifact": ARTIFACT, "archiveSha256": ARCHIVE_SHA256, "source": SOURCE,
    "baseTree": BASE_TREE, "expectedTree": root_tree, "files": manifest,
    "branchesModified": False, "commitsCreated": False,
}
print("QA769_REVIEW_MANIFEST=" + json.dumps(record, separators=(",", ":")), flush=True)
