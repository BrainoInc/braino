-- A capability declaration carries the exact contract version the component
-- implements. The component ABI and artifact stay unchanged; only the
-- manifest's ambiguous string list becomes one name-to-version map.
UPDATE plugin_installations
   SET manifest = jsonb_set(
     jsonb_set(manifest, '{protocolVersion}', '2'::jsonb),
     '{capabilities}',
     (
       SELECT COALESCE(jsonb_object_agg(capability, '1'::jsonb), '{}'::jsonb)
         FROM jsonb_array_elements_text(manifest->'capabilities') AS capability
     )
   )
 WHERE manifest->>'protocolVersion' = '1'
   AND jsonb_typeof(manifest->'capabilities') = 'array';
