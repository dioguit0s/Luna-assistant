#pragma once

// Versão do firmware: FW_VERSION (semver, `custom_fw_version` no
// platformio.ini) e FW_BUILD (SHA curto do git, ou "dev"). Os valores vêm de
// fw_version_gen.h, gerado por tools/fw_version.py a cada build; os fallbacks
// abaixo só valem fora do PlatformIO (IDE indexando, build sem o script).
#if __has_include("fw_version_gen.h")
#include "fw_version_gen.h"
#endif

#ifndef FW_VERSION
#define FW_VERSION "0.0.0"
#endif

#ifndef FW_BUILD
#define FW_BUILD "dev"
#endif
