# File uploads

`form()` reads `multipart/form-data` bodies; files are `File` objects, Bun's, with `name`, `type`, `size` and the content.

## One file

```ts
const Avatar = z.object({
  avatar: z
    .instanceof(File)
    .refine((file) => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type), 'PNG, JPEG or WebP is expected'),
})

type Avatar = z.infer<typeof Avatar>

@Post('me/avatar', [form(Avatar, { maxFileSize: 2 * 1024 * 1024, maxFiles: 1 }), value(USER)])
@HttpCode(204)
async uploadAvatar(input: Avatar, user: User) {
  await Bun.write(`uploads/${user.id}.img`, input.avatar)
}
```

```bash
curl -X POST localhost:3000/me/avatar -F avatar=@photo.png -H "authorization: Bearer $TOKEN"
```

## Several files and fields

A repeated field, or a field named `photos[]`, is an array:

```ts
const Album = z.object({
  title: z.string().min(1),
  photos: z.array(z.instanceof(File)).min(1).max(20),
})

type Album = z.infer<typeof Album>

@Post('albums', [form(Album, { maxFileSize: 10 * 1024 * 1024, maxFiles: 20, maxBodySize: 100 * 1024 * 1024 })])
create(album: Album) {}
```

A single `photos` field gives a single `File`, not an array: `z.array()` then refuses it. Name the field `photos[]` in the client to always get an array.

## Limits

Each limit answers `413` as soon as it is exceeded:

| Limit | |
|---|---|
| `maxBodySize` | bytes of the whole body, checked while it is read: a huge upload is refused without being stored |
| `maxFileSize` | bytes of each file |
| `maxFiles` | number of files |
| `maxFields` | number of fields, files included |

Without `maxBodySize`, the server's `maxRequestBodySize` (Bun's 128 MiB unless lowered in `listen()`) still applies. Set limits on every upload route: a form without them accepts as many files as the client sends.

## Content type

`file.type` is what the client declared. When it matters, check the content itself, its first bytes for instance:

```ts
const isPng = async (file: File) => {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())

  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte)
}
```

Never build a path from `file.name`: it is written by the client, `../../etc/passwd` included. Name stored files yourself, with an id.

## Storage

`Bun.write(path, file)` stores on disk. For S3 and compatible storages (R2, MinIO), Bun has a client built in:

```ts
import { s3 } from 'bun'

await s3.write(`avatars/${user.id}`, input.avatar, { type: input.avatar.type })
```

It reads its credentials from `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` and `S3_ENDPOINT`.

## Downloads

Return a file, or `Bun.file()`, and it is streamed:

```ts
@Get('files/:id', [param('id', uuid)])
download(id: string) {
  return new Response(Bun.file(`uploads/${id}`), {
    headers: { 'content-disposition': `attachment; filename="${id}"` },
  })
}
```
