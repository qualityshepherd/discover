export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

export const parseJsonBody = async (req) => {
  try { return await req.json() } catch { return null }
}
