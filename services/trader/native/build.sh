#!/usr/bin/env bash
# Compile the shim against Lighter's signer. Needs a C compiler and nothing else.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
"$here/fetch-signer.sh"

case "$(uname -s)" in
  Darwin) lib=$(ls "$here/vendor"/lighter-signer-*.dylib | head -1); out="$here/vendor/shim.dylib"
          cc -O2 -shared -fPIC -I"$here/vendor" -o "$out" "$here/shim.c" "$lib" \
             -Wl,-rpath,"@loader_path" -install_name "@rpath/shim.dylib"
          # The signer records itself by bare name, so rpath never applies to
          # it. Point the reference beside the shim, where it actually sits.
          install_name_tool -change "$(basename "$lib")" "@loader_path/$(basename "$lib")" "$out" ;;
  Linux)  lib=$(ls "$here/vendor"/lighter-signer-*.so | head -1); out="$here/vendor/shim.so"
          cc -O2 -shared -fPIC -I"$here/vendor" -o "$out" "$here/shim.c" "$lib" \
             -Wl,-rpath,'$ORIGIN' ;;
  *) echo "unsupported: $(uname -s)" >&2; exit 1 ;;
esac
echo "built $(basename "$out")"
