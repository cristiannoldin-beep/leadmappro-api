import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

// ── Credenciais UazAPI ────────────────────────────────────────────────────────
async function getUazapiCredentials(accountId: string): Promise<{ baseUrl: string; globalKey: string }> {
  const [globalUrl, globalKey] = await Promise.all([
    prisma.configuracaoIntegracao.findUnique({ where: { chave: 'UAZAPI_BASE_URL' } }),
    prisma.configuracaoIntegracao.findUnique({ where: { chave: 'UAZAPI_GLOBAL_KEY' } }),
  ])

  let baseUrl = globalUrl?.valor ?? null
  if (!baseUrl) {
    const cred = await prisma.credencial.findUnique({
      where: { accountId_chave: { accountId, chave: 'UAZAPI_BASE_URL' } },
    })
    if (cred?.ativa) {
      try { baseUrl = decrypt(cred.valorCriptografado) } catch { /* ignore */ }
    }
  }

  const rawBase = baseUrl ?? 'https://api.uazapi.com'
  return {
    baseUrl: rawBase.replace(/\/+$/, ''), // remove trailing slash
    globalKey: globalKey?.valor ?? '',
  }
}

// Operação de instância: usa header 'token'
async function uazapiRequest(baseUrl: string, instanceToken: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', token: instanceToken },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`UazAPI ${method} ${path}: ${res.status} ${err}`)
  }
  return res.json()
}

// Operação admin: usa header 'admintoken' (uazapiGO V2)
async function uazapiAdminRequest(baseUrl: string, adminKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', admintoken: adminKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`UazAPI ${method} ${path}: ${res.status} ${err}`)
  }
  return res.json()
}

// Extrai QR code de resposta da UazAPI V2 em qualquer campo possível
function extractQr(data: Record<string, unknown>): string | null {
  return (
    (data.qrcode as string) ??
    (data.qr as string) ??
    (data.base64 as string) ??
    (data.qrCode as string) ??
    (data.qr_code as string) ??
    (data.qrCodeBase64 as string) ??
    (data.qrbase64 as string) ??
    (data.image as string) ??
    (data.pairingCode as string) ??
    null
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export async function whatsappRoutes(app: FastifyInstance) {

  // ── Listar conexões ────────────────────────────────────────────────────────
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

  // ── Testar conexão com UazAPI (diagnóstico) ───────────────────────────────
  app.get('/whatsapp/testar-conexao', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const { baseUrl, globalKey } = await getUazapiCredentials(accountId)
    if (!globalKey) {
      return reply.send({ ok: false, erro: 'UAZAPI_GLOBAL_KEY não configurada no painel admin.', baseUrl })
    }

    const resultados: Record<string, unknown> = {}

    // uazapiGO V2: POST /instance/create com admintoken e campo 'name'
    try {
      const res = await fetch(`${baseUrl}/instance/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', admintoken: globalKey },
        body: JSON.stringify({ name: '__diag_test__' }),
        signal: AbortSignal.timeout(8000),
      })
      const txt = await res.text()
      resultados['POST /instance/create (admintoken)'] = { status: res.status, body: txt.slice(0, 300) }
      if (res.ok || res.status === 401 || res.status === 403) {
        if (res.ok) {
          await fetch(`${baseUrl}/instance/delete`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', admintoken: globalKey },
            body: JSON.stringify({ name: '__diag_test__' }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => null)
          return reply.send({ ok: true, endpointFuncionando: 'POST /instance/create', status: res.status, baseUrl, resultados })
        }
        return reply.send({ ok: false, endpointEncontrado: 'POST /instance/create', erroAuth: txt.slice(0, 300), baseUrl, resultados })
      }
    } catch (err) {
      resultados['POST /instance/create (admintoken)'] = { erro: err instanceof Error ? err.message : String(err) }
    }

    // Fallback: testa com outros headers para compatibilidade
    for (const [label, headers] of [
      ['(token+apikey)', { token: globalKey, apikey: globalKey }],
      ['(Authorization Bearer)', { Authorization: `Bearer ${globalKey}` }],
    ] as [string, Record<string, string>][]) {
      try {
        const res = await fetch(`${baseUrl}/instance/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ name: '__diag_test__' }),
          signal: AbortSignal.timeout(5000),
        })
        const txt = await res.text()
        resultados[`POST /instance/create ${label}`] = { status: res.status, body: txt.slice(0, 200) }
      } catch (err) {
        resultados[`POST /instance/create ${label}`] = { erro: err instanceof Error ? err.message : String(err) }
      }
    }

    return reply.send({ ok: false, baseUrl, resultados })
  })

  // ── Criar instância + retornar QR code ────────────────────────────────────
  app.post('/whatsapp/conexoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      provider: z.enum(['meta_official', 'uazapi']),
      apelido: z.string().optional(),
      instanceName: z.string().min(3),
      instanceKey: z.string().optional(),
    }).parse(request.body)

    if (body.provider === 'uazapi') {
      const { baseUrl, globalKey } = await getUazapiCredentials(accountId)
      if (!globalKey) {
        return reply.status(400).send({ message: 'Chave UazAPI global não configurada. Acesse Configurações → Admin.' })
      }

      const webhookUrl = `${process.env.API_PUBLIC_URL ?? ''}/webhooks/whatsapp`

      try {
        // uazapiGO V2: POST /instance/create com admintoken e campo 'name'
        const createUrl = `${baseUrl}/instance/create`
        const createRes = await fetch(createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', admintoken: globalKey },
          body: JSON.stringify({ name: body.instanceName }),
        })

        if (!createRes.ok) {
          const txt = await createRes.text()
          return reply.status(502).send({ message: `Erro UazAPI [${createUrl}]: ${createRes.status} ${txt}` })
        }

        const createData = await createRes.json() as {
          instanceKey?: string
          token?: string
          status?: string
          qrcode?: string
          qr?: string
          base64?: string
          alreadyConnected?: boolean
          connection_status?: string
        }

        // uazapiGO V2 retorna 'token' para operações de instância
        const instanceKey = createData.token ?? createData.instanceKey ?? body.instanceKey ?? ''
        const alreadyConnected = createData.alreadyConnected
          || createData.status === 'connected'
          || createData.connection_status === 'open'

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
          status: alreadyConnected ? 'connected' : 'disconnected',
        }

        const conexao = existing
          ? await prisma.whatsappConexao.update({ where: { id: existing.id }, data: conexaoData })
          : await prisma.whatsappConexao.create({ data: conexaoData })

        if (alreadyConnected) {
          return reply.send({ conexao, alreadyConnected: true })
        }

        // Buscar QR code via POST /instance/connect (uazapiGO V2)
        let qrCode: string | null = createData.qrcode ?? createData.qr ?? createData.base64 ?? null

        if (!qrCode && instanceKey) {
          try {
            const connectRes = await fetch(`${baseUrl}/instance/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', token: instanceKey },
              body: JSON.stringify({ webhook: webhookUrl }),
            })
            if (connectRes.ok) {
              const qrData = await connectRes.json() as Record<string, unknown>
              qrCode = extractQr(qrData)
            }
            // V2: QR pode estar em GET /instance/qr separado
            if (!qrCode) {
              const qrRes = await fetch(`${baseUrl}/instance/qr`, {
                headers: { token: instanceKey },
              })
              if (qrRes.ok) {
                const qrData = await qrRes.json() as Record<string, unknown>
                qrCode = extractQr(qrData)
              }
            }
          } catch { /* QR optional at this stage */ }
        }

        return reply.status(201).send({ conexao, qrCode })

      } catch (err) {
        return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao criar instância.' })
      }
    }

    // Meta Official — apenas salva credenciais
    const conexao = await prisma.whatsappConexao.create({ data: { ...body, accountId } })
    const { instanceKey: _, ...safeConexao } = conexao
    return reply.status(201).send({ conexao: safeConexao })
  })

  // ── Buscar QR code de instância existente ─────────────────────────────────
  app.get('/whatsapp/:id/qrcode', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const conexao = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!conexao) return reply.status(404).send({ message: 'Conexão não encontrada.' })
    if (conexao.provider !== 'uazapi' || !conexao.instanceKey) {
      return reply.status(400).send({ message: 'QR Code disponível apenas para instâncias UazAPI.' })
    }

    const { baseUrl } = await getUazapiCredentials(accountId)
    try {
      // uazapiGO V2: tenta GET /instance/qr, fallback para POST /instance/connect
      let qrCode: string | null = null
      try {
        const qrRes = await uazapiRequest(baseUrl, conexao.instanceKey, 'GET', '/instance/qr') as Record<string, unknown>
        qrCode = extractQr(qrRes)
      } catch { /* fallback */ }
      if (!qrCode) {
        const connectData = await uazapiRequest(baseUrl, conexao.instanceKey, 'POST', '/instance/connect', {}) as Record<string, unknown>
        qrCode = extractQr(connectData)
      }
      return reply.send({ qrCode })
    } catch (err) {
      return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao buscar QR.' })
    }
  })

  // ── Status da instância (usado pelo frontend para polling pós-QR) ─────────
  app.get('/whatsapp/:id/status', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const conexao = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!conexao) return reply.status(404).send({ message: 'Conexão não encontrada.' })

    if (conexao.provider !== 'uazapi' || !conexao.instanceKey) {
      return reply.send({ status: conexao.status })
    }

    const { baseUrl } = await getUazapiCredentials(accountId)
    try {
      const statusData = await uazapiRequest(baseUrl, conexao.instanceKey, 'GET', '/instance/status') as {
        status?: string; connectionStatus?: string; connection_status?: string; state?: string
      }
      const raw = statusData.status ?? statusData.connectionStatus ?? statusData.connection_status ?? statusData.state ?? 'unknown'
      const dbStatus = raw === 'open' || raw === 'connected' ? 'connected' : 'disconnected'

      if (conexao.status !== dbStatus) {
        await prisma.whatsappConexao.update({ where: { id }, data: { status: dbStatus } })
      }

      return reply.send({ status: dbStatus, raw })
    } catch {
      return reply.send({ status: conexao.status })
    }
  })

  // ── Deletar instância ──────────────────────────────────────────────────────
  app.delete('/whatsapp/conexoes/:id', { preValidation: [requireAuth] }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const { accountId } = request.user as JwtPayload
    const conexao = await prisma.whatsappConexao.findFirst({ where: { id, accountId } })
    if (!conexao) return reply.status(404).send({ message: 'Conexão não encontrada.' })

    if (conexao.provider === 'uazapi' && conexao.instanceKey) {
      const { baseUrl } = await getUazapiCredentials(accountId)
      try { await uazapiRequest(baseUrl, conexao.instanceKey, 'DELETE', '/instance/delete') } catch { /* ignore */ }
    }

    await prisma.whatsappConexao.delete({ where: { id } })
    return reply.status(204).send()
  })
}
