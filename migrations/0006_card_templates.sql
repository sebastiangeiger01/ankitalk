-- Preserve original Anki card templates so review rendering can respect card ordinals.

ALTER TABLE cards ADD COLUMN front_template TEXT;
ALTER TABLE cards ADD COLUMN back_template TEXT;
