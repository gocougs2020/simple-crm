ALTER TABLE "clients" ADD COLUMN "product_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- Fills the new field from what clients are subscribed to now, with the same rules as productFamily in src/lib/product-rules.ts. The Stripe sync keeps it up to date from here.
UPDATE "clients" c SET "product_lines" = coalesce((
  SELECT jsonb_agg(line ORDER BY position)
  FROM (
    SELECT DISTINCT line, array_position(ARRAY['TalentScout', 'CoRecruit', 'ThirdPool', 'HiringCenter', 'VRA'], line) AS position
    FROM (
      SELECT CASE
        WHEN n LIKE '%contract recruiter%' OR n LIKE '%virtual recruiting assistant%' THEN 'VRA'
        WHEN n LIKE '%hiringcenter + recruitment marketing%' OR n = 'subscription' THEN 'ThirdPool'
        WHEN n LIKE '%recruit365%' THEN 'CoRecruit'
        WHEN n LIKE '%talentscout%' THEN 'TalentScout'
        WHEN n LIKE '%corecruit%' THEN 'CoRecruit'
        WHEN n LIKE '%thirdpool%' THEN 'ThirdPool'
        WHEN n LIKE '%hiringcenter%' THEN 'HiringCenter'
        WHEN n LIKE '%vra%' THEN 'VRA'
      END AS line
      FROM (SELECT lower(trim(p)) AS n FROM jsonb_array_elements_text(c."stripe_products") p) names
    ) lines
    WHERE line IS NOT NULL
  ) found
), '[]'::jsonb)
WHERE jsonb_array_length(c."stripe_products") > 0;
