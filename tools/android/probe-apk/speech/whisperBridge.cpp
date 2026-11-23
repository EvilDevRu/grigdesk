#include <cstdint>
#include <vector>

#include "whisper.h"

extern "C" {

// Модель загружается один раз на процесс диктовки или разбора файла.
// CPU работает на том же наборе устройств, что и локальный сервер.
whisper_context * grigdesk_whisper_open(const char * model) {
    auto params = whisper_context_default_params();
    params.use_gpu = false;
    return whisper_init_from_file_with_params(model, params);
}

// Рабочий процесс передаёт моно PCM 16 кГц. Параметры в ABI простые,
// а устройство whisper_full_params остаётся внутри сборки whisper.cpp.
int grigdesk_whisper_decode(
    whisper_context * ctx, const int16_t * pcm, int size, const char * language,
    int threads, int beam, const char * prompt, bool condition, bool timestamps
) {
    std::vector<float> samples(pcm, pcm + size);
    for (auto & sample : samples) {
        sample /= 32768.0f;
    }

    auto params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    params.language = language;
    params.n_threads = threads;
    params.beam_search.beam_size = beam;
    params.initial_prompt = prompt;
    params.no_context = !condition;
    params.token_timestamps = timestamps;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    return whisper_full(ctx, params, samples.data(), size);
}

// Возвращает сырые метки токена, пригодность интервалов проверяет worker.
// Служебные токены в текст и словесные интервалы не входят.
const char * grigdesk_whisper_token(
    whisper_context * ctx, int segment, int token, int64_t * start, int64_t * end
) {
    const auto data = whisper_full_get_token_data(ctx, segment, token);
    if (data.id >= whisper_token_eot(ctx)) {
        return nullptr;
    }
    *start = data.t0;
    *end = data.t1;
    return whisper_full_get_token_text(ctx, segment, token);
}

}
