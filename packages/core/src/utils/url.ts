/**
 * The path of an absolute URL, without its query: `http://h:3000/users/7?full=1` gives `/users/7`.
 * Cheaper than `new URL()` on the request path.
 */
export const pathOf = (url: string): string => {
  const start = url.indexOf('/', url.indexOf('//') + 2)

  if (start === -1) {
    return '/'
  }

  const query = url.indexOf('?', start)

  return query === -1 ? url.slice(start) : url.slice(start, query)
}
