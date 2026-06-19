import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'
import { checkLimit } from '../lib/limits'

// ── Google Places API ────────────────────────────────────────────────────────
const PLACES_API = 'https://places.googleapis.com/v1/places:searchText'
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.nationalPhoneNumber',
  'places.formattedAddress',
  'places.websiteUri',
  'places.addressComponents',
  'nextPageToken',
].join(',')

interface PlaceResult {
  id?: string
  displayName?: { text?: string }
  nationalPhoneNumber?: string
  formattedAddress?: string
  websiteUri?: string
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[]
}

interface PlacesResponse {
  places?: PlaceResult[]
  nextPageToken?: string
}

function extractCidadeEstado(components: PlaceResult['addressComponents']) {
  let cidade: string | null = null
  let estado: string | null = null
  for (const comp of components ?? []) {
    if (!cidade && (comp.types?.includes('locality') || comp.types?.includes('administrative_area_level_2'))) {
      cidade = comp.longText ?? null
    }
    if (!estado && comp.types?.includes('administrative_area_level_1')) {
      estado = comp.shortText ?? null
    }
  }
  return { cidade, estado }
}

async function getCredencial(accountId: string, chave: string): Promise<string | null> {
  // 1. Global admin config (takes priority — admin manages keys for all users)
  const global = await prisma.configuracaoIntegracao.findUnique({ where: { chave } })
  if (global?.valor) return global.valor
  // 2. Per-account credential as fallback (encrypted)
  const cred = await prisma.credencial.findUnique({
    where: { accountId_chave: { accountId, chave } },
  })
  if (cred?.ativa) {
    try { return decrypt(cred.valorCriptografado) } catch { /* ignore */ }
  }
  return null
}

// ── WAHA / UazAPI helper ─────────────────────────────────────────────────────
interface WahaConnection {
  instanceName: string
  instanceKey: string
  baseUrl: string
}

async function getWahaConnection(accountId: string): Promise<WahaConnection | null> {
  const conn = await prisma.whatsappConexao.findFirst({
    where: { accountId, status: 'connected' },
    orderBy: { createdAt: 'asc' },
  })
  if (!conn) return null
  const baseUrl = (await getCredencial(accountId, 'UAZAPI_BASE_URL')) ?? 'https://api.uazapi.com'
  return { instanceName: conn.instanceName ?? '', instanceKey: conn.instanceKey ?? '', baseUrl }
}

async function checkPhone(waha: WahaConnection, phone: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${waha.baseUrl}/chat/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: waha.instanceKey },
      body: JSON.stringify({ phone }),
    })
    if (!res.ok) return null
    const data = await res.json() as { exists?: boolean; hasWhatsapp?: boolean }
    return data.exists ?? data.hasWhatsapp ?? null
  } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function prospeccaoRoutes(app: FastifyInstance) {

  // ── 1. Gerar variações de busca com OpenAI ──────────────────────────────
  app.post('/prospeccao/gerar-variacoes', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      listaId: z.string().uuid(),
      segmento: z.string().min(2),
      cidade: z.string().optional(),
      estado: z.string().optional(),
    }).parse(request.body)

    const lista = await prisma.lista.findFirst({ where: { id: body.listaId, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const openaiKey = await getCredencial(accountId, 'OPENAI_API_KEY')
    if (!openaiKey) return reply.status(400).send({ message: 'Credencial OpenAI não configurada. Acesse Configurações → Integrações.' })

    const cidade = body.cidade ?? lista.cidade ?? ''
    const estado = body.estado ?? lista.estado ?? ''
    const localizacao = [cidade, estado].filter(Boolean).join(', ')

    const prompt = `Você é especialista em prospecção de empresas brasileiras via Google Maps.
Gere exatamente 15 variações de busca para encontrar "${body.segmento}" ${localizacao ? `em ${localizacao}` : ''}.
Regras:
- Cada variação deve ser uma query de busca diferente para o mesmo tipo de empresa
- Use sinônimos, variações de nome, especializações e subtipos do segmento
- ${localizacao ? `Cada variação DEVE incluir a localização: ${localizacao}` : 'Inclua variações geográficas (norte, sul, centro, etc)'}
- Entre 10 e 80 caracteres por variação
- Retorne APENAS as 15 variações, uma por linha, sem numeração, bullets ou prefixos`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 500,
      }),
    })

    if (!res.ok) return reply.status(502).send({ message: 'Erro ao chamar OpenAI.' })
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content ?? ''

    const variacoes = content
      .split('\n')
      .map((l: string) => l.replace(/^\d+[\.\)]\s*/, '').replace(/^[-•*]\s*/, '').trim())
      .filter((l: string) => l.length >= 5 && l.length <= 120)
      .slice(0, 15)

    await prisma.lista.update({
      where: { id: body.listaId },
      data: { googleVariacoesIa: variacoes },
    })

    return reply.send({ variacoes, quantidade: variacoes.length })
  })

  // ── 2. Buscar empresas no Google Maps ───────────────────────────────────
  app.post('/prospeccao/google-maps', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    await checkLimit(accountId, 'leads')
    const body = z.object({
      listaId: z.string().uuid(),
      query: z.string().min(1).optional(),
    }).parse(request.body)

    const lista = await prisma.lista.findFirst({ where: { id: body.listaId, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const apiKey = await getCredencial(accountId, 'GOOGLE_MAPS_API_KEY')
    if (!apiKey) return reply.status(400).send({ message: 'Credencial Google Maps não configurada. Acesse Configurações → Integrações.' })

    // Escolher próxima variação não utilizada
    const variacoes = lista.googleVariacoesIa.length > 0
      ? lista.googleVariacoesIa
      : body.query ? [body.query] : []

    if (variacoes.length === 0) {
      return reply.status(400).send({ message: 'Nenhuma variação de busca disponível. Gere as variações primeiro.' })
    }

    const queriesUsadas = new Set(lista.googleQueriesUsadas ?? [])
    const proximaVariacao = variacoes.find(v => !queriesUsadas.has(v)) ?? variacoes[0]

    const placeIdsConhecidos = new Set(lista.googlePlaceIds)
    const localizacao = [lista.cidade, lista.estado].filter(Boolean).join(' ')
    const textQuery = (localizacao && !proximaVariacao.toLowerCase().includes(localizacao.toLowerCase()))
      ? `${proximaVariacao} em ${localizacao}`
      : proximaVariacao

    let inseridos = 0
    let duplicados = 0
    let ignorados = 0
    let pageToken: string | undefined
    let paginasProcessadas = 0
    const novosPlaceIds: string[] = []

    // Até 3 páginas por variação (≈60 resultados)
    do {
      const placesRes = await fetch(PLACES_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery,
          languageCode: 'pt-BR',
          regionCode: 'BR',
          maxResultCount: 20,
          ...(pageToken ? { pageToken } : {}),
        }),
      })

      if (!placesRes.ok) {
        const errBody = await placesRes.text().catch(() => '')
        return reply.status(502).send({
          message: `Google Places API erro ${placesRes.status}. Verifique se "Places API (New)" está ativada no Google Cloud Console e se a chave tem faturamento habilitado. Detalhe: ${errBody.slice(0, 200)}`,
        })
      }

      const placesData = await placesRes.json() as PlacesResponse
      const places = placesData.places ?? []
      pageToken = placesData.nextPageToken

      for (const place of places) {
        const placeId = place.id ?? ''

        // Deduplicação por place_id
        if (placeId && placeIdsConhecidos.has(placeId)) { duplicados++; continue }
        if (placeId) { placeIdsConhecidos.add(placeId); novosPlaceIds.push(placeId) }

        const nomeEmpresa = place.displayName?.text ?? 'Empresa sem nome'
        const telefone = place.nationalPhoneNumber?.replace(/[\s\-\(\)]/g, '') ?? null
        const website = place.websiteUri ?? null
        const endereco = place.formattedAddress ?? null
        const { cidade, estado } = extractCidadeEstado(place.addressComponents)

        if (!telefone) { ignorados++; continue }

        try {
          let contato = await prisma.contato.findFirst({ where: { telefone } })
          if (!contato) {
            contato = await prisma.contato.create({
              data: { nomeEmpresa, telefone, website, endereco, cidade, estado },
            })
          }
          const existing = await prisma.listaContato.findUnique({
            where: { listaId_contatoId: { listaId: body.listaId, contatoId: contato.id } },
          })
          if (existing) { duplicados++; continue }

          await prisma.listaContato.create({
            data: { listaId: body.listaId, contatoId: contato.id, fonteBusca: textQuery },
          })
          inseridos++
        } catch { ignorados++ }
      }

      paginasProcessadas++
      if (pageToken && paginasProcessadas < 3) await new Promise(r => setTimeout(r, 2000))
    } while (pageToken && paginasProcessadas < 3)

    // Salvar place_ids e marcar query como usada
    const novasQueriesUsadas = [...queriesUsadas, proximaVariacao]
    await prisma.lista.update({
      where: { id: body.listaId },
      data: {
        googlePlaceIds: { push: novosPlaceIds },
        googleQueriesUsadas: novasQueriesUsadas,
      },
    })

    const queriesRestantes = variacoes.filter(v => !novasQueriesUsadas.includes(v)).length

    return reply.send({
      inseridos,
      duplicados,
      ignorados,
      total: inseridos + duplicados,
      queryUtilizada: textQuery,
      queriesRestantes,
      todasQueriesUsadas: queriesRestantes === 0,
      paginasProcessadas,
    })
  })

  // ── 3. Validar WhatsApp em lote ─────────────────────────────────────────
  app.post('/prospeccao/validar-whatsapp', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      listaId: z.string().uuid(),
      limit: z.number().int().min(1).max(50).default(20),
      force: z.boolean().default(false),
    }).parse(request.body)

    const lista = await prisma.lista.findFirst({ where: { id: body.listaId, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const waha = await getWahaConnection(accountId)
    if (!waha) return reply.status(400).send({ message: 'Nenhuma conexão WhatsApp ativa. Conecte uma instância primeiro.' })

    const where = {
      listaId: body.listaId,
      ...(body.force
        ? { statusWhatsapp: { notIn: ['telefone_invalido'] } }
        : { statusWhatsapp: 'nao_validado' }),
    }

    const registros = await prisma.listaContato.findMany({
      where,
      include: { contato: { select: { id: true, telefone: true } } },
      take: body.limit,
      orderBy: { createdAt: 'asc' },
    })

    let validos = 0, invalidos = 0, erros = 0

    for (const reg of registros) {
      const telefone = reg.contato.telefone?.replace(/\D/g, '') ?? ''
      if (telefone.length < 10) {
        await prisma.listaContato.update({
          where: { id: reg.id },
          data: { statusWhatsapp: 'telefone_invalido' },
        })
        invalidos++
        continue
      }

      const numero = telefone.startsWith('55') ? telefone : `55${telefone}`
      const resultado = await checkPhone(waha, numero)

      const status = resultado === true ? 'valido' : resultado === false ? 'invalido' : 'erro'
      await prisma.listaContato.update({
        where: { id: reg.id },
        data: { statusWhatsapp: status },
      })

      if (status === 'valido') validos++
      else if (status === 'invalido') invalidos++
      else erros++

      // Delay entre validações para evitar rate limit
      await new Promise(r => setTimeout(r, 300))
    }

    const remaining = await prisma.listaContato.count({
      where: { listaId: body.listaId, statusWhatsapp: 'nao_validado' },
    })

    return reply.send({
      processados: registros.length,
      validos,
      invalidos,
      erros,
      hasMore: remaining > 0,
      remaining,
    })
  })

  // ── 4. Variações legadas (stub para Casa dos Dados) ─────────────────────
  app.post('/prospeccao/casadosdados', { preValidation: [requireAuth] }, async (_request, reply) => {
    return reply.send({ contatos: [], total: 0, message: 'Em breve.' })
  })
}
