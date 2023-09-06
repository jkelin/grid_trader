FROM python:3.11
WORKDIR /app
EXPOSE 80
CMD ["uvicorn", "infinite_bot:app", "--host", "0.0.0.0", "--port", "80", "--log-level", "error"]

RUN pip install poetry
RUN poetry config virtualenvs.create false

COPY pyproject.toml poetry.lock ./
RUN poetry install --no-interaction --no-ansi

COPY infinite_bot.py .
