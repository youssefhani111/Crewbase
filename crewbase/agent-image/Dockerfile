# The computer each agent gets (free mode). One container per agent, its files live in a volume at /workspace.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl wget git jq unzip zip ca-certificates nodejs npm poppler-utils procps \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir requests beautifulsoup4 pandas openpyxl matplotlib

RUN useradd -m -u 1000 -s /bin/bash agent \
    && mkdir -p /workspace /opt/crewbase \
    && chown agent:agent /workspace

COPY webtool.py /opt/crewbase/webtool.py

# Let the agent install Python/Node packages for itself without root.
ENV PIP_USER=1 PATH=/home/agent/.local/bin:/home/agent/.npm-global/bin:$PATH NPM_CONFIG_PREFIX=/home/agent/.npm-global

USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
