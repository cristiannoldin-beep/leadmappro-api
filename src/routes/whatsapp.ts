import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

// ── Evolution API ─────────────────────────────────────────────────────────────
const EVO_URL = (process.env.EVOLUTION_API_URL ?? '').replace(/\/+$/, '')
const EVO_KEY = process.env.EVOLUTION_API_KEY ?? ''

async function evoRequest(method: string, path: string, body?: unknown) {
  const res = await fetch(`${EVO_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: EVO_KEY },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Evolution ${method} ${path}: ${res.status} ${err}`)
  }
  return res.json()
}

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
    baseUrl: rawBase.replace(/\/+$/, ''),
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
    ((data.instance as Record<string, unknown>)?.qrcode as string) ??
    ((data.data as Record<string, unknown>)?.qrcode as string) ??
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

    // uazapiGO: POST /instance/init com tripla de headers
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

    return reply.send({ ok: false, baseUrl, resultados })
  })

  // ── Criar instância + retornar QR code ────────────────────────────────────
  app.post('/whatsapp/conexoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      provider: z.enum(['meta_official', 'uazapi', 'evolution']),
      apelido: z.string().optional(),
      instanceName: z.string().min(3),
      instanceKey: z.string().optional(),
    }).parse(request.body)

    // ── Evolution API ──────────────────────────────────────────────────────
    if (body.provider === 'evolution') {
      if (!EVO_URL || !EVO_KEY) {
        return reply.status(400).send({ message: 'Evolution API não configurada. Adicione EVOLUTION_API_URL e EVOLUTION_API_KEY nas variáveis de ambiente.' })
      }

      const webhookUrl = `${process.env.API_PUBLIC_URL ?? ''}/webhooks/evolution`

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const createData = await evoRequest('POST', '/instance/create', {
          instanceName: body.instanceName,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          groupsIgnore: true,
          readMessages: false,
          readStatus: false,
        }) as any

        const instanceKey: string = createData.hash?.apikey ?? createData.token ?? ''
        const instanceStatus: string = (createData.instance?.status ?? '').toLowerCase()
        const alreadyConnected = instanceStatus === 'open' || instanceStatus === 'connected'

        // Salvar/atualizar conexão no banco
        const existing = await prisma.whatsappConexao.findFirst({
          where: { accountId, instanceName: body.instanceName },
        })

        const conexaoData = {
          accountId,
          provider: 'evolution',
          apelido: body.apelido ?? body.instanceName,
          instanceName: body.instanceName,
          instanceKey,
          status: alreadyConnected ? 'connected' : 'disconnected',
        }

        const conexao = existing
          ? await prisma.whatsappConexao.update({ where: { id: existing.id }, data: conexaoData })
          : await prisma.whatsappConexao.create({ data: conexaoData })

        // Configura webhook apenas com eventos de status — MESSAGES_UPSERT é ativado
        // no handler de CONNECTION_UPDATE após a conta estar estável e conectada.
        if (webhookUrl) {
          evoRequest('POST', `/webhook/set/${body.instanceName}`, {
            enabled: true,
            url: webhookUrl,
            webhookByEvents: false,
            webhookBase64: false,
            events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE'],
          }).catch(() => null)
        }

        if (alreadyConnected) {
          return reply.send({ conexao, alreadyConnected: true })
        }

        // QR code pode vir diretamente na resposta de criação
        // Evolution retorna: qrcode.base64 = imagem PNG; qrcode.code = string raw (não é base64)
        let qrCode: string | null = null
        const qrcodeObj = createData.qrcode
        if (qrcodeObj?.base64) {
          qrCode = qrcodeObj.base64.startsWith('data:') ? qrcodeObj.base64 : `data:image/png;base64,${qrcodeObj.base64}`
        }

        // Se não veio na criação, busca via /instance/connect
        if (!qrCode) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const connectData = await evoRequest('GET', `/instance/connect/${body.instanceName}`) as any
            if (connectData.base64) {
              qrCode = connectData.base64.startsWith('data:') ? connectData.base64 : `data:image/png;base64,${connectData.base64}`
            }
          } catch { /* continua sem QR */ }
        }

        return reply.status(201).send({ conexao, qrCode })

      } catch (err) {
        return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao criar instância Evolution.' })
      }
    }

    // ── UazAPI ────────────────────────────────────────────────────────────
    if (body.provider === 'uazapi') {
      const { baseUrl, globalKey } = await getUazapiCredentials(accountId)
      if (!globalKey) {
        return reply.status(400).send({ message: 'Chave UazAPI global não configurada. Acesse Configurações → Admin.' })
      }

      const webhookUrl = `${process.env.API_PUBLIC_URL ?? ''}/webhooks/whatsapp`

      try {
        // uazapiGO V2: POST /instance/create (não /instance/init)
        const createUrl = `${baseUrl}/instance/create`
        const createRes = await fetch(createUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            admintoken: globalKey,
          },
          body: JSON.stringify({ name: body.instanceName }),
          signal: AbortSignal.timeout(10000),
        })

        if (!createRes.ok) {
          const txt = await createRes.text().catch(() => createRes.statusText)
          return reply.status(502).send({ message: `Erro UazAPI [${createUrl}]: ${createRes.status} ${txt}` })
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const createData = await createRes.json() as any

        // uazapiGO V2 retorna 'token' para operações de instância
        const instanceKey = createData.token ?? createData.instanceKey ?? body.instanceKey ?? ''
        const rawCreateState = (createData?.state ?? createData?.status ?? createData?.connection_status ?? createData?.connectionStatus ?? '').toString().toLowerCase()
        const alreadyConnected = !!createData.alreadyConnected
          || createData.connected === true
          || createData.loggedIn === true
          || rawCreateState === 'connected'
          || rawCreateState === 'open'

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

        // Buscar QR: uazapiGO retorna QR na resposta do /instance/connect
        let qrCode: string | null = extractQr(createData as unknown as Record<string, unknown>)

        if (!qrCode && instanceKey) {
          // Delay de 2s igual ao código de referência que funciona
          await new Promise(r => setTimeout(r, 2000))

          // Awaita o connect — uazapiGO retorna o QR diretamente nesta resposta
          try {
            const connectRes = await fetch(`${baseUrl}/instance/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', token: instanceKey },
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(15000),
            })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const connectData = await connectRes.json().catch(() => ({})) as any
            if (connectRes.ok) {
              qrCode = extractQr(connectData as Record<string, unknown>)
            }
            // 486 = instância já conectada na UazAPI mas DB desatualizado
            if (!connectRes.ok && (connectRes.status === 486 || connectData?.connected === true || connectData?.loggedIn === true)) {
              await prisma.whatsappConexao.update({ where: { id: conexao.id }, data: { status: 'connected' } })
              return reply.send({ conexao: { ...conexao, status: 'connected' }, alreadyConnected: true })
            }
          } catch { /* continua para polling */ }

          // Se ainda sem QR, tenta GET /instance/qr com até 3 tentativas (2s cada)
          for (let attempt = 0; attempt < 3 && !qrCode; attempt++) {
            await new Promise(r => setTimeout(r, 2000))
            try {
              const qrRes = await fetch(`${baseUrl}/instance/qr`, {
                headers: { token: instanceKey },
                signal: AbortSignal.timeout(6000),
              })
              if (qrRes.ok) {
                qrCode = extractQr(await qrRes.json() as Record<string, unknown>)
              }
            } catch { /* próxima tentativa */ }
          }
        }

        return reply.status(201).send({ conexao, qrCode })

      } catch (err) {
        return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao criar instância.' })
      }
    }

    // ── Meta Official — apenas salva credenciais ───────────────────────────
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

    // ── Evolution QR ───────────────────────────────────────────────────────
    if (conexao.provider === 'evolution') {
      if (!conexao.instanceName) return reply.status(400).send({ message: 'instanceName ausente.' })
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await evoRequest('GET', `/instance/connect/${conexao.instanceName}`) as any
        let qrCode: string | null = null
        // Evolution: base64 = imagem PNG; code = string raw do QR (não é base64)
        if (data.base64) {
          qrCode = data.base64.startsWith('data:') ? data.base64 : `data:image/png;base64,${data.base64}`
        }
        return reply.send({ qrCode })
      } catch (err) {
        return reply.status(502).send({ message: err instanceof Error ? err.message : 'Erro ao buscar QR Evolution.' })
      }
    }

    // ── UazAPI QR ──────────────────────────────────────────────────────────
    if (conexao.provider !== 'uazapi' || !conexao.instanceKey) {
      return reply.status(400).send({ message: 'QR Code disponível apenas para instâncias UazAPI ou Evolution.' })
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

    // ── Evolution status ───────────────────────────────────────────────────
    if (conexao.provider === 'evolution') {
      if (!conexao.instanceName) return reply.send({ status: conexao.status })
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await evoRequest('GET', `/instance/connectionState/${conexao.instanceName}`) as any
        const rawState = (data?.instance?.state ?? data?.state ?? '').toLowerCase()
        const isConnectedNow = rawState === 'open' || rawState === 'connected'
        const dbStatus = isConnectedNow ? 'connected' : rawState === 'connecting' ? 'connecting' : 'disconnected'

        if (conexao.status !== dbStatus) {
          await prisma.whatsappConexao.update({ where: { id }, data: { status: dbStatus } })
        }
        return reply.send({ status: dbStatus, isConnectedNow, raw: data })
      } catch {
        return reply.send({ status: conexao.status })
      }
    }

    // ── UazAPI status ──────────────────────────────────────────────────────
    if (conexao.provider !== 'uazapi' || !conexao.instanceKey) {
      return reply.send({ status: conexao.status })
    }

    const { baseUrl } = await getUazapiCredentials(accountId)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statusData = await fetch(`${baseUrl}/instance/status`, {
        headers: { token: conexao.instanceKey },
        signal: AbortSignal.timeout(6000),
      }).then(r => r.json()) as any

      const rawState = (statusData?.state ?? statusData?.status ?? statusData?.connectionStatus ?? statusData?.connection_status ?? '').toString().toLowerCase()
      const isConnectedNow =
        statusData?.connected === true ||
        statusData?.loggedIn === true ||
        rawState === 'open' ||
        rawState === 'connected'
      const dbStatus = isConnectedNow ? 'connected' : 'disconnected'

      if (conexao.status !== dbStatus) {
        await prisma.whatsappConexao.update({ where: { id }, data: { status: dbStatus } })
      }
      return reply.send({ status: dbStatus, isConnectedNow, raw: statusData })
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

    // ── Remover da Evolution ───────────────────────────────────────────────
    if (conexao.provider === 'evolution' && conexao.instanceName) {
      try {
        await evoRequest('DELETE', `/instance/delete/${conexao.instanceName}`)
      } catch { /* ignore — apaga do banco mesmo que Evolution falhe */ }
    }

    // ── Remover da UazAPI ──────────────────────────────────────────────────
    if (conexao.provider === 'uazapi' && conexao.instanceName) {
      const { baseUrl, globalKey } = await getUazapiCredentials(accountId)
      try {
        await uazapiAdminRequest(baseUrl, globalKey, 'DELETE', '/instance/delete', { name: conexao.instanceName })
      } catch { /* ignore — apaga do banco mesmo que UazAPI falhe */ }
    }

    await prisma.whatsappConexao.delete({ where: { id } })
    return reply.status(204).send()
  })
}
