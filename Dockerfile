FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir requests

COPY . .

ENV SERVER_HOST=0.0.0.0

EXPOSE 8765

CMD ["python3", "server.py"]
