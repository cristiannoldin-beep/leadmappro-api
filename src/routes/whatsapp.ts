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

// Operação admin: envia tanto 'token' quanto 'apikey' para compatibilidade com SaaS e self-hosted
async function uazapiAdminRequest(baseUrl: string, adminKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', token: adminKey, apikey: adminKey },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`UazAPI ${method} ${path}: ${res.status} ${err}`)
  }
  return res.json()
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

    // Testa POST /instance/create com body mínimo — 200/201 = chave válida
    try {
      const createRes = await fetch(`${baseUrl}/instance/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: globalKey, apikey: globalKey },
        body: JSON.stringify({ instanceName: '__diag_test__' }),
        signal: AbortSignal.timeout(8000),
      })
      const createTxt = await createRes.text()
      resultados['POST /instance/create'] = { status: createRes.status, body: createTxt.slice(0, 300) }
      if (createRes.ok) {
        // Deleta a instância de teste imediatamente
        await fetch(`${baseUrl}/instance/delete`, {
          method: 'DELETE',
          headers: { token: globalKey, apikey: globalKey },
          body: JSON.stringify({ instanceName: '__diag_test__' }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => null)
        return reply.send({ ok: true, endpointFuncionando: 'POST /instance/create', status: createRes.status, baseUrl, resultados })
      }
    } catch (err) {
      resultados['POST /instance/create'] = { erro: err instanceof Error ? err.message : String(err) }
    }

    // Testa GET /instance/list (pode retornar lista vazia mas com 200)
    for (const path of ['/instance/list', '/v1/instance/list', '/instances', '/']) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          headers: { token: globalKey, apikey: globalKey },
          signal: AbortSignal.timeout(5000),
        })
        const txt = await res.text()
        resultados[`GET ${path}`] = { status: res.status, body: txt.slice(0, 200) }
      } catch (err) {
        resultados[`GET ${path}`] = { erro: err instanceof Error ? err.message : String(err) }
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
        // Criar instância com apikey admin
        const createUrl = `${baseUrl}/instance/create`
        const createRes = await fetch(createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: globalKey },
          body: JSON.stringify({
            instanceName: body.instanceName,
            webhook: webhookUrl,
            webhookEnabled: true,
          }),
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

        // UazAPI pode retornar 'token' ou 'instanceKey'
        const instanceKey = createData.instanceKey ?? createData.token ?? body.instanceKey ?? ''
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

        // Buscar QR code — resposta do create pode já incluir
        let qrCode: string | null = createData.qrcode ?? createData.qr ?? createData.base64 ?? null

        if (!qrCode && instanceKey) {
          try {
            const qrRes = await fetch(`${baseUrl}/instance/connect`, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json', token: instanceKey },
            })
            if (qrRes.ok) {
              const qrData = await qrRes.json() as { qrcode?: string; qr?: string; base64?: string }
              qrCode = qrData.qrcode ?? qrData.qr ?? qrData.base64 ?? null
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
      const qrData = await uazapiRequest(baseUrl, conexao.instanceKey, 'GET', '/instance/connect') as {
        qrcode?: string; qr?: string; base64?: string
      }
      return reply.send({ qrCode: qrData.qrcode ?? qrData.qr ?? qrData.base64 ?? null })
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
