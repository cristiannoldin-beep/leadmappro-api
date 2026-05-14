import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { requireAuth, JwtPayload } from '../lib/auth'

export async function prospeccaoRoutes(app: FastifyInstance) {
  // Substitui: buscar-empresas-google-maps
  app.post('/prospeccao/google-maps', { preValidation: [requireAuth] }, async (request, reply) => {
    const { accountId } = request.user as JwtPayload
    const body = z.object({
      listaId: z.string().uuid(),
      query: z.string().min(1),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      nextPageToken: z.string().optional(),
    }).parse(request.body)

    // TODO: migrar lógica da Edge Function buscar-empresas-google-maps
    // Requer: GOOGLE_MAPS_API_KEY da tabela configuracoes_integracoes ou credenciais
    return reply.send({ contatos: [], nextPageToken: null, message: 'TODO: implementar busca Google Maps' })
  })

  // Substitui: buscar-empresas-casadosdados
  app.post('/prospeccao/casadosdados', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      listaId: z.string().uuid(),
      cnae: z.string().optional(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
      page: z.number().default(1),
    }).parse(request.body)

    // TODO: migrar lógica da Edge Function buscar-empresas-casadosdados
    return reply.send({ contatos: [], total: 0, message: 'TODO: implementar busca Casa dos Dados' })
  })

  // Substitui: iniciar-prospeccao
  app.post('/prospeccao/iniciar', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      listaId: z.string().uuid(),
      queries: z.array(z.string()),
      provider: z.enum(['google_maps', 'casadosdados']).default('google_maps'),
    }).parse(request.body)

    // TODO: iniciar processo de prospecção assíncrono
    return reply.send({ message: 'Prospecção iniciada.', listaId: body.listaId })
  })

  // Substitui: gerar-variacoes-busca
  app.post('/prospeccao/variacoes-busca', { preValidation: [requireAuth] }, async (request, reply) => {
    const body = z.object({
      segmento: z.string(),
      cidade: z.string().optional(),
      estado: z.string().optional(),
    }).parse(request.body)

    // TODO: chamar OpenAI para gerar variações de busca
    return reply.send({ variacoes: [], message: 'TODO: gerar variações com IA' })
  })
}
