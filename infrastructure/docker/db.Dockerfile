# syntax=docker/dockerfile:1
# Build gosu with the current Go toolchain instead of inheriting the older
# static gosu binary bundled in the PostgreSQL image.
FROM golang:1.26-alpine AS gosu
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/tianon/gosu@1.20

FROM postgres:16-alpine
RUN apk upgrade --no-cache && rm -rf /var/cache/apk/*
COPY --from=gosu /out/gosu /usr/local/bin/gosu
