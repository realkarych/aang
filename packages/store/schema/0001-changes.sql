CREATE TABLE change_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0)
) STRICT;

INSERT INTO change_counter (id, value) VALUES (1, 0);
