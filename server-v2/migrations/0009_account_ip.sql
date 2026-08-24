-- Track the egress IP each LinkedIn account actually operates from.
-- In desktop/remote mode the driver runs on the USER's own machine, so this is
-- the user's residential IP as LinkedIn sees it — captured by the desktop agent
-- (an ipify echo) and reported back with each login/action result. Useful for
-- (a) confirming an account runs from a consistent residential IP, and
-- (b) spotting the split-brain case (same account seen from two IPs).
alter table linkedin_accounts
  add column if not exists login_ip   inet,        -- IP captured at the one-time login
  add column if not exists last_ip    inet,        -- most recent IP seen on ANY job
  add column if not exists last_ip_at timestamptz; -- when last_ip was recorded
