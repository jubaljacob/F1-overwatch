# Supabase

P0 schema lives in `migrations/`. Two ways to apply it:

**Local Postgres (docker-compose):** the migrations directory is mounted into the Postgres container's init dir, so `docker compose up` applies them on first boot. To re-apply after edits, drop the volume: `docker compose down -v && docker compose up -d`.

**Supabase cloud:**

```powershell
# Install: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref <your-ref>
supabase db push
```

After provisioning, fill `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`.

P0 leaves these tables unused; first writer is P7 (saved replays + annotations).
