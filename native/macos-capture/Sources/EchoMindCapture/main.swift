import Foundation

// A dead parent must surface as EPIPE / stdin EOF (graceful stop), not kill us via SIGPIPE.
signal(SIGPIPE, SIG_IGN)
CLI.main(Array(CommandLine.arguments.dropFirst()))
