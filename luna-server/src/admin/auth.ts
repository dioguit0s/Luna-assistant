import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Comparação em tempo constante do token admin. Os dois lados passam por
 * SHA-256 antes: `timingSafeEqual` exige o mesmo tamanho, e comparar o
 * tamanho antes vazaria o comprimento do token pelo tempo de resposta.
 */
export function adminTokenMatches(expected: string, header: string | undefined): boolean {
  if (!expected || !header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(match[1]!.trim()).digest();
  return timingSafeEqual(a, b);
}

/**
 * Loopback ou faixa privada (RFC 1918), inclusive na forma IPv4-mapeada
 * (`::ffff:192.168.0.5`) que o Node entrega num socket dual-stack.
 *
 * Defesa em profundidade para o dia em que a porta for aberta no roteador
 * por causa dos satélites (ADR 010, decisão 2) — não substitui o token.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.toLowerCase();
  if (addr === '::1') return true;

  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((o) => Number.isNaN(o) || o > 255)) return false;

  const [a, b] = octets as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
