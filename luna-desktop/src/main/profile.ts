// Perfil alternativo de userData, só para dev/teste: `LUNA_USER_DATA_DIR`
// aponta o app para outro diretório (settings.json, device.json, mic-dump),
// sem tocar no perfil real — dá para testar contra um servidor local com
// outra identidade enquanto o app de verdade continua configurado.
//
// Módulo de efeito colateral, importado PRIMEIRO em index.ts: config.ts lê
// app.getPath('userData') no carregamento, e sob ESM os imports são avaliados
// em ordem, antes do corpo de index.ts. O lock de instância única do Electron
// é por userData, então um perfil isolado também não briga com o app aberto.

import { app } from 'electron';
import { resolve } from 'node:path';

const dir = process.env.LUNA_USER_DATA_DIR?.trim();
if (dir) {
  app.setPath('userData', resolve(dir));
  console.log(`[luna-desktop] perfil alternativo (LUNA_USER_DATA_DIR): ${resolve(dir)}`);
}
