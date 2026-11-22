FROM python:3.12-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends git clang make ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --no-checkout https://github.com/yaneurao/YaneuraOu.git /src \
 && cd /src && git checkout 76d58ef2e4cf64116784f41fd4816425ab6817ee \
 && test "$(git rev-parse HEAD)" = 76d58ef2e4cf64116784f41fd4816425ab6817ee
RUN apt-get update && apt-get install -y --no-install-recommends lld && rm -rf /var/lib/apt/lists/*
# OTHER はスカラー実装。AVX/SSE拡張やBMI2/POPCNTを仮定しない x86-64 ベースライン。
RUN cd /src && python source/eval/nnue/architectures/nnue_arch_gen.py SFNN_halfka2_1024_7_64_k3k3 \
 && cd source && make -j2 COMPILER=clang++ TARGET_CPU=OTHER \
 YANEURAOU_EDITION=YANEURAOU_ENGINE_SFNN_halfka2_1024_7_64_k3k3 \
 EXTRA_CPPFLAGS='-march=x86-64 -mtune=generic' \
 && cp YaneuraOu-by-gcc /engine
RUN cd /src/source && make clean && make -j2 COMPILER=clang++ TARGET_CPU=AVX2 \
 YANEURAOU_EDITION=YANEURAOU_ENGINE_SFNN_halfka2_1024_7_64_k3k3 \
 && cp YaneuraOu-by-gcc /engine-avx2

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --only-binary=:all: pip==26.3 \
 && python -m pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY --from=build /engine /app/engine-compatible
COPY --from=build /engine-avx2 /app/engine-avx2
COPY eval/nn.bin /app/eval/nn.bin
RUN echo 'a78b7f889843037d344f482623b3febd124ead5c1f34f134d9f1c2c78cd0f829  /app/eval/nn.bin' | sha256sum -c -
COPY bridge.py coach_facts.py coach_tools.py coach_tools_schema.json coach_knowledge.py shogi_input.py benchmark.py LICENSE /app/
COPY knowledge/ /app/knowledge/
RUN useradd --uid 10001 --no-create-home worker && chown -R worker:worker /app
USER worker
EXPOSE 8080
CMD ["python", "-u", "bridge.py"]
