#!/usr/bin/env bash
# Pull Lighter's official signer out of their Python wheel.
#
# It is a Go library compiled to a C shared object, published only inside that
# wheel. Nothing Python is installed or run: the wheel is a zip and this takes
# the two files out of it. Vendoring the binary instead would mean a 30MB blob
# in git that nobody can diff.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/vendor"
ver="${LIGHTER_SDK_VERSION:-1.1.4}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) lib="lighter-signer-darwin-arm64.dylib" ;;
  Darwin-x86_64) lib="lighter-signer-darwin-amd64.dylib" ;;
  Linux-aarch64|Linux-arm64) lib="lighter-signer-linux-arm64.so" ;;
  Linux-x86_64) lib="lighter-signer-linux-amd64.so" ;;
  *) echo "no signer for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
head="${lib%.*}.h"

mkdir -p "$out"
if [ -f "$out/$lib" ] && [ -f "$out/signer.h" ]; then
  echo "signer already here: $lib"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="$(curl -fsSL "https://pypi.org/pypi/lighter-sdk/$ver/json" | python3 -c 'import json,sys; print(next(u["url"] for u in json.load(sys.stdin)["urls"] if u["packagetype"]=="bdist_wheel"))')"
echo "fetching $ver"
curl -fsSL "$url" -o "$tmp/sdk.whl"
python3 -c "
import zipfile, shutil, sys
z = zipfile.ZipFile('$tmp/sdk.whl')
for name in z.namelist():
    if name.endswith('$lib'): shutil.copyfileobj(z.open(name), open('$out/$lib','wb'))
    if name.endswith('$head'): shutil.copyfileobj(z.open(name), open('$out/signer.h','wb'))
"
[ -f "$out/$lib" ] || { echo "no $lib in the wheel" >&2; exit 1; }
echo "signer: $lib"
