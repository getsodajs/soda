import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => c.text('Hi'))
app.get('/id/:id', (c) => {
  c.header('x-powered-by', 'benchmark')

  return c.text(`${c.req.param('id')} ${c.req.query('name')}`)
})
app.post('/json', async (c) => c.json(await c.req.json()))

Bun.serve({ port: Number(process.env.PORT), fetch: app.fetch })
