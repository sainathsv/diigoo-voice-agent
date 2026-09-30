-- Private call programs (2026-09-28).
--
-- A program written for one client (CY Police's cyber crime complaint line)
-- must not appear in any other client's catalogue, and must not be set up by
-- another client who guesses its key. Null means every client in the vertical,
-- as before; a list means only the workspaces with those slugs.

alter table program_templates add column if not exists tenant_slugs text[];
