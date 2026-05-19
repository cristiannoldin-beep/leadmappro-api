import { prisma } from './prisma'
import { decrypt } from './encryption'

export async function getCredencial(accountId: string, chave: string): Promise<string | null> {
  const global = await prisma.configuracaoIntegracao.findUnique({ where: { chave } })
  if (global?.valor) return global.valor
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave } },
  })
  if (cred?.ativa) {
    try { return decrypt(cred.valorCriptografado) } catch { /* ignore */ }
  }
  return null
}

export async function getUazapiConnection(accountId: string) {
  const conn = await prisma.whatsappConexao.findFirst({
    where: { accountId, status: 'connected' },
    orderBy: { createdAt: 'asc' },
  })
  if (!conn?.instanceKey) return null
  const baseUrl = (await getCredencial(accountId, 'UAZAPI_BASE_URL')) ?? 'https://api.uazapi.com'
  return { instanceName: conn.instanceName ?? '', instanceKey: conn.instanceKey, baseUrl, conexaoId: conn.id }
}
