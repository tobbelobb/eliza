docker build -t ghcr.io/tobbelobb/eliza:prod .
docker run -it --rm ghcr.io/tobbelobb/eliza:prod sh
docker push ghcr.io/tobbelobb/eliza:prod

# Becomes available here:
https://github.com/users/tobbelobb/packages/container/package/eliza
