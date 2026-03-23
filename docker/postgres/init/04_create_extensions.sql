-- Create extensions that require superuser privileges.
-- Run as postgres superuser during init.

\c news_maker_agent
CREATE EXTENSION IF NOT EXISTS vector;

\c news_maker_agent_test
CREATE EXTENSION IF NOT EXISTS vector;
