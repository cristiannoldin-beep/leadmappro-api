import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

async function getUazapiBaseUrl(accountId: string): Promise<string> {
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave: 'UAZAPI_BASE_URL' } },
  })
  if (!cred?.ativa) return 'https://api.uazapi.com'
  return decrypt(cred.valorCriptografado)
}

async function uazapiRequest(baseUrl: string, instanceKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'instance-key': instanceKey },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`UazAPI ${method} ${path}: ${res.status} ${err}`)
  }
  return res.json()
}

export async function whatsappRoutes(app: FastifyInstance) {
  app.get('/whatsapp/conexoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const conexoes = await prisma.whatsappConexao.findMany({
      where: { accountId },
      select: {
        id: true, provider: true, status: true, numeroTelefone: true,
        apelido: true, wabaId: true, phoneNumberId: true,
        instanceName: true, createdAt: true, updatedAt: true,
      },
    })
    return reply.send({ conexoes })
  })

  // Criar instância UazAPI + retornar QR code
  app.post('/whatsapp/conexoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      provider: z.enum(['meta_official', 'uazapi']),
      apelido: z.string().optional(),
      instanceName: z.string().min(3),
      instanceKey: z.string().optional(),
    }).parse(request.body)

    if (body.provider === 'uazapi') {
      const baseUrl = await getUazapiBaseUrl(accountId)
      const webhookUrl = `${process.env.API_PUBLIC_URL ?? ''}/webhooks/whatsapp`

      try {
        // Criar a instância na UazAPI
        const createRes = await fetch(`${baseUrl}/v1/instance/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instanceName: body.instanceName,
            webhook: webhookUrl,
            webhookEnabled: true,
          }),
        })

        if (!createRes.ok) {
          const txt = await createRes.text()
          return reply.status(502).send({ message: `Erro UazAPI: ${txt}` })
        }

        const createData = await createRes.json() as { instanceKey?: string; status?: string; qrcode?: string; alreadyConnected?: boolean }

        const instanceKey = createData.instanceKey ?? body.instanceKey ?? ''

        // Salvar/atualizar conexão no banco
        const existing = await prisma.whatsappConexao.findFirst({
          where: { accountId, instanceName: body.instanceName },
        })

        const conexaoData = {
          accountId,
          provider: 'uazapi',
          apelido: body.apelido ?? body.instanceName,
          instanceName: body.instanceName,
          instanceKey,
          status: createData.alreadyConnected ? 'connected' : 'disconnected',
        }

        const conexao = existing
          ? await prisma.whatsappConexao.update({ where: { id: existing.id }, data: conexaoData })
          : await prisma.whatsappConexao.create({ data: conexaoData })

        if (createData.alreadyConnected) {
          return reply.send({ conexao, alreadyConnected: true })
        }

        // Buscar QR code
        let qrCode: string | null = createData.qrcode ?? null
        if (!qrCode && instanceKey) {
          try {
            const qrRes = await fetch(`${baseUrl}/v1/instance/qr`, {
              method: 'GET',
              headers: { 'instance-key': instanceKey },
            })
            if (qrRes.ok) {
              const qrData = await qrRes.json() as { qrcode?: string; base64?: string }
              qrCode = qrData.qrcode ?? qrData.base64 ?? null
            }
          } catch {}
        }

        return reply.status(201).send({ conexao, qrCode })

      } catch (err) {
        return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao criar instância.' })
      }
    }

    // Meta Official — apenas salva as credenciais
    const conexao = await prisma.whatsappConexao.create({ data: { ...body, accountId } })
    const { instanceKey: _, ...safeConexao } = conexao
    return reply.status(201).send({ conexao: safeConexao })
  })

  // Recarregar QR code para instância existente
  app.get('/whatsapp/:id/qrcode', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const conexao = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!conexao) return reply.status(404).send({ message: 'Conexão não encontrada.' })
    if (conexao.provider !== 'uazapi' || !conexao.instanceKey) {
      return reply.status(400).send({ message: 'QR Code disponível apenas para instâncias UazAPI.' })
    }

    const baseUrl = await getUazapiBaseUrl(accountId)
    try {
      const qrData = await uazapiRequest(baseUrl, conexao.instanceKey, 'GET', '/v1/instance/qr') as { qrcode?: string; base64?: string }
      return reply.send({ qrCode: qrData.qrcode ?? qrData.base64 ?? null })
    } catch (err) {
      return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao buscar QR.' })
    }
  })

  app.delete('/whatsapp/conexoes/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const conexao = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!conexao) return reply.status(404).send({ message: 'Conexão não encontrada.' })

    // Tentar deletar instância na UazAPI
    if (conexao.provider === 'uazapi' && conexao.instanceKey) {
      const baseUrl = await getUazapiBaseUrl(accountId)
      try {
        await uazapiRequest(baseUrl, conexao.instanceKey, 'DELETE', '/v1/instance/delete')
      } catch {}
    }

    await prisma.whatsappConexao.delete({ where: { id } })
    return reply.status(204).send()
  })
}
