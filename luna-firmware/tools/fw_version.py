# Versão do firmware embutida no build (extra_scripts do platformio.ini).
#
# FW_VERSION = semver de `custom_fw_version` no platformio.ini (subir à mão a
#              cada release de firmware).
# FW_BUILD   = SHA curto do último commit que tocou luna-firmware/ (commit só
#              de servidor ou docs não muda o build de um firmware idêntico),
#              com ".dirty" se há mudança não commitada ali; "dev" sem git.
#              Identifica a origem, não o binário: o OTA compara FW_VERSION.
#
# Build de release (workflow firmware-release.yml): LUNA_FW_VERSION e
# LUNA_FW_BUILD no ambiente substituem os dois — a versão vem da tag fw-vX.Y.Z
# e o build é o SHA curto do commit da tag, o mesmo `build` do manifest.json.
#
# Vai num header gerado em $BUILD_DIR/gen/fw_version_gen.h, não em CPPDEFINES:
# um -D novo a cada commit mudaria a linha de comando de TODO objeto (inclusive
# das libs, TFLite junto) e forçaria rebuild completo. Com o header, só
# recompila quem inclui include/version.h. O arquivo só é reescrito se o
# conteúdo mudou.

import os
import re
import subprocess

Import("env")  # noqa: F821 (injetado pelo SCons)


def git(*args):
    try:
        out = subprocess.check_output(
            ["git", *args],
            cwd=env.subst("$PROJECT_DIR"),  # noqa: F821
            stderr=subprocess.DEVNULL,
        )
        return out.decode("utf-8", "replace").strip()
    except Exception:
        return None


version = os.environ.get("LUNA_FW_VERSION", "").strip() or env.GetProjectOption(  # noqa: F821
    "custom_fw_version", "0.0.0"
).strip()

build = os.environ.get("LUNA_FW_BUILD", "").strip()
if not build:
    sha = git("log", "-1", "--format=%h", "--abbrev=7", "--", ".")
    if sha:
        dirty = git("status", "--porcelain", "--", ".")
        build = sha + (".dirty" if dirty else "")
    else:
        build = "dev"

# Vai parar num literal C: nada de aspas, barras nem espaço vindo do ambiente.
for name, value in (("FW_VERSION", version), ("FW_BUILD", build)):
    if not re.fullmatch(r"[0-9A-Za-z.+-]{1,32}", value):
        raise SystemExit(f"[fw_version] {name} inválido: {value!r}")

gen_dir = os.path.join(env.subst("$BUILD_DIR"), "gen")  # noqa: F821
os.makedirs(gen_dir, exist_ok=True)
header = os.path.join(gen_dir, "fw_version_gen.h")
content = (
    "// Gerado por tools/fw_version.py a cada build. Não editar.\n"
    "#pragma once\n"
    f'#define FW_VERSION "{version}"\n'
    f'#define FW_BUILD "{build}"\n'
)

try:
    with open(header, "r", encoding="utf-8") as f:
        current = f.read()
except OSError:
    current = None
if current != content:
    with open(header, "w", encoding="utf-8") as f:
        f.write(content)

env.Append(CPPPATH=[gen_dir])  # noqa: F821
print(f"[fw_version] {version}+{build}")
