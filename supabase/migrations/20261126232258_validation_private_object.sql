-- Validation-only synthetic object access. Populate the two approved Clerk
-- subjects and issuer separately through the private operator procedure.
CREATE SCHEMA rafiq_validation;
REVOKE ALL ON SCHEMA rafiq_validation FROM PUBLIC;

CREATE TABLE rafiq_validation.object_subjects (
    issuer text NOT NULL CHECK (issuer LIKE 'https://%'),
    subject text NOT NULL CHECK (subject LIKE 'user\_%' ESCAPE '\'),
    PRIMARY KEY (issuer, subject)
);
ALTER TABLE rafiq_validation.object_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE rafiq_validation.object_subjects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rafiq_validation.object_subjects FROM PUBLIC;
GRANT USAGE ON SCHEMA rafiq_validation TO authenticated;
GRANT SELECT (issuer, subject) ON rafiq_validation.object_subjects TO authenticated;
CREATE POLICY validation_subject_self ON rafiq_validation.object_subjects
    FOR SELECT TO authenticated
    USING (issuer = (SELECT auth.jwt() ->> 'iss') AND subject = (SELECT auth.jwt() ->> 'sub'));

CREATE POLICY validation_private_object_read ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'rafiq-validation-fixtures'
        AND name = ((SELECT auth.jwt() ->> 'sub') || '/private-access-check.txt')
        AND storage.allow_any_operation(ARRAY['object.get_authenticated_info', 'object.get_authenticated'])
        AND EXISTS (
            SELECT 1 FROM rafiq_validation.object_subjects AS allowed
            WHERE allowed.issuer = (SELECT auth.jwt() ->> 'iss')
              AND allowed.subject = (SELECT auth.jwt() ->> 'sub')
        )
    );
