-- The review cards posted into the IA cases and tickets channels.
--
-- Until now the card's message id was thrown away the moment it was posted, so
-- nothing could tell a record that HAS a card from one that never got one. That
-- is why every ticket ingested before review cards shipped sat in the database
-- as PENDING and never appeared in the tickets channel: it was stored, and
-- nobody was ever shown it.
ALTER TABLE "cases"       ADD COLUMN IF NOT EXISTS "cardMessageId" TEXT;
ALTER TABLE "ticket_logs" ADD COLUMN IF NOT EXISTS "cardMessageId" TEXT;
