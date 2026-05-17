import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'
import { decrypt } from '../lib/encryption'

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

function extractCidadeEstado(components: PlaceResult['addressComponents']): { cidade: string | null; estado: string | null } {
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

export async function prospeccaoRoutes(app: FastifyInstance) {
  app.post('/prospeccao/google-maps', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      listaId: z.string().uuid(),
      query: z.string().min(1),
      nextPageToken: z.string().optional(),
    }).parse(request.body)

    const credencial = await prisma.credencial.findUnique({
      where: { accountId_chave: { accountId, chave: 'GOOGLE_MAPS_API_KEY' } },
    })
    if (!credencial?.ativa) {
      return reply.status(400).send({ message: 'Credencial Google Maps não configurada. Acesse Configurações → Integrações.' })
    }
    const apiKey = decrypt(credencial.valorCriptografado)

    const lista = await prisma.lista.findFirst({ where: { id: body.listaId, accountId } })
    if (!lista) return reply.status(404).send({ message: 'Lista não encontrada.' })

    const localizacao = [lista.cidade, lista.estado].filter(Boolean).join(' ')
    const textQuery = localizacao ? `${body.query} em ${localizacao}` : body.query

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
        ...(body.nextPageToken ? { pageToken: body.nextPageToken } : {}),
      }),
    })

    if (!placesRes.ok) {
      const err = await placesRes.json().catch(() => ({}))
      return reply.status(502).send({ message: 'Erro na API do Google Maps.', detalhes: err })
    }

    const placesData: PlacesResponse = await placesRes.json()
    const places = placesData.places ?? []
    const newNextPageToken = placesData.nextPageToken ?? null

    let inseridos = 0
    let ignorados = 0

    for (const place of places) {
      const nomeEmpresa = place.displayName?.text ?? 'Empresa sem nome'
      const telefone = place.nationalPhoneNumber?.replace(/\s+/g, '') ?? null
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

        await prisma.listaContato.upsert({
          where: { listaId_contatoId: { listaId: body.listaId, contatoId: contato.id } },
          update: {},
          create: { listaId: body.listaId, contatoId: contato.id, fonteBusca: textQuery },
        })
        inseridos++
      } catch {
        ignorados++
      }
    }

    await prisma.lista.update({
      where: { id: body.listaId },
      data: { googleNextPageToken: newNextPageToken },
    })

    return reply.send({ inseridos, ignorados, total: places.length, nextPageToken: newNextPageToken })
  })

  app.post('/prospeccao/casadosdados', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      listaId: z.string().uuid(),
      cnae: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      page: z.number().default(1),
    }).parse(request.body)
    return reply.send({ contatos: [], total: 0, message: 'TODO: implementar busca Casa dos Dados' })
  })

  app.post('/prospeccao/variacoes-busca', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      segmento: z.string(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
    }).parse(request.body)
    return reply.send({ variacoes: [], message: 'TODO: gerar variações com IA' })
  })
}
