-- Sign-in code guesses, per email ("email:<address>" hourly, "email-day:<address>" daily)
-- and per IP ("ip:<address>" hourly), in fixed windows. Sending a new code doesn't reset
-- them, so a code can't be guessed by resending over and over (src/auth.ts, spendGuess).
CREATE TABLE login_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  guesses INTEGER NOT NULL
);
CREATE INDEX login_limits_window ON login_limits (window_start);
