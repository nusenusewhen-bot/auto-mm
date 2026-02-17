FROM uphold/litecoin-core:latest

EXPOSE 9332 9333

CMD ["litecoind", "-server=1", "-txindex=1", "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcuser=user", "-rpcpassword=pass"]
